import Foundation
import Darwin

func regularFiles(_ directory: URL) throws -> [URL] {
    guard let enumerator = fm.enumerator(at: directory, includingPropertiesForKeys: [.isRegularFileKey,.isSymbolicLinkKey]) else { throw fail("无法读取应用目录。") }
    return try enumerator.compactMap { item -> URL? in
        guard let url = item as? URL else { return nil }; let values = try url.resourceValues(forKeys: [.isRegularFileKey,.isSymbolicLinkKey]); return values.isRegularFile == true && values.isSymbolicLink != true ? url : nil
    }
}
func copyTree(_ source: URL, _ target: URL) throws {
    guard !fm.fileExists(atPath: target.path) else { throw fail("备份目录已经存在，已停止覆盖。") }
    try fm.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let clone = try run("/bin/cp", ["-cR",source.path,target.path], requireSuccess: false)
    if clone.code != 0 { if fm.fileExists(atPath: target.path) { try fm.removeItem(at: target) }; try run("/usr/bin/ditto", [source.path,target.path]) }
}
func relative(_ file: URL, under directory: URL) throws -> String {
    let root = directory.standardizedFileURL.resolvingSymlinksInPath().path + "/", full = file.standardizedFileURL.resolvingSymlinksInPath().path
    guard full.hasPrefix(root) else { throw fail("文件路径超出应用目录。") }; return String(full.dropFirst(root.count))
}
func checkedPath(_ relative: String, under root: URL) throws -> URL {
    guard !relative.hasPrefix("/"), !relative.split(separator: "/").contains(".."), relative.hasPrefix("Contents/") else { throw fail("备份清单包含无效路径。") }
    let result = root.appendingPathComponent(relative); _ = try selfRelative(result, root); return result
}
private func selfRelative(_ file: URL, _ root: URL) throws -> String { try relative(file, under: root) }
func copyFileAtomically(_ source: URL, _ destination: URL) throws {
    let tmp = destination.deletingLastPathComponent().appendingPathComponent(".czt-\(UUID().uuidString)")
    defer { try? fm.removeItem(at: tmp) }; try fm.copyItem(at: source, to: tmp)
    guard rename(tmp.path, destination.path) == 0 else { throw fail("应用文件无法写入；请检查所选应用的写入权限。") }
}
struct Journal: Codable {
    var app: String; var rollback: String; var files: [FileRecord]; var previousManifest: Data?; var committed = false
}
struct PatchStatus {
    var version: String; var patched: Bool; var managed: Bool; var current: Bool; var interrupted: Bool
}
struct Installer {
    var paths: Paths; var bridge: URL
    func withLock<T>(_ app: URL, _ action: () throws -> T) throws -> T {
        let directory=paths.root.appendingPathComponent("locks");try fm.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions:0o700])
        let file=directory.appendingPathComponent(digest(Data(app.standardizedFileURL.path.utf8))+".lock")
        let descriptor=Darwin.open(file.path,O_CREAT|O_RDWR,mode_t(0o600));guard descriptor >= 0 else {throw fail("无法创建安装锁。")}
        defer{Darwin.close(descriptor)}
        guard Darwin.lockf(descriptor,F_TLOCK,0)==0 else {throw fail("另一个补丁操作正在进行，请等待完成。")}
        defer{Darwin.lockf(descriptor,F_ULOCK,0)};return try action()
    }
    func journalURL(_ app: URL) -> URL { paths.root.appendingPathComponent("transactions/\(digest(Data(app.standardizedFileURL.path.utf8))).json") }
    func status(_ app: URL) throws -> PatchStatus {
        let info = try appInfo(app), archive = try Asar(app.appendingPathComponent("Contents/Resources/app.asar"))
        let patched = archive.entries().contains { $0.0 == bridgePrefix + "main.cjs" }, record = try paths.loadRecord(for: app)
        let versionData = try? archive.read(bridgePrefix + "version.json"), installed = versionData.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: String] }?["version"]
        return PatchStatus(version: info["CFBundleShortVersionString"] as? String ?? "未知", patched: patched, managed: record != nil, current: installed == patchVersion, interrupted: fm.fileExists(atPath: journalURL(app).path))
    }
    func verifyRecord(_ record: Installation, app: URL) throws {
        guard record.app == app.standardizedFileURL.path, !record.files.isEmpty else { throw fail("备份不属于当前所选应用。") }
        let backup = URL(fileURLWithPath: record.backup); guard backup.standardizedFileURL != app.standardizedFileURL else { throw fail("原版备份路径无效。") }
        let originalInfo = try appInfo(backup), liveInfo = try appInfo(app)
        guard originalInfo["CFBundleShortVersionString"] as? String == record.version, liveInfo["CFBundleShortVersionString"] as? String == record.version else { throw fail("Claude 版本已经变化，已阻止覆盖官方更新。") }
        var seen = Set<String>()
        for item in record.files {
            guard seen.insert(item.path).inserted else { throw fail("备份清单包含重复文件。") }
            let original = try checkedPath(item.path, under: backup), live = try checkedPath(item.path, under: app)
            guard try fileDigest(original) == item.originalSHA256 else { throw fail("原版备份校验失败，未修改应用。") }
            guard try fileDigest(live) == item.installedSHA256 else { throw fail("Claude 文件已发生变化，已阻止覆盖更新。") }
        }
    }
    func importRecord(_ file: URL, for app: URL) throws -> String? {
        try withLock(app) { try importRecordUnlocked(file,for:app) }
    }
    private func importRecordUnlocked(_ file: URL, for app: URL) throws -> String? {
        var record = try JSONDecoder().decode(Installation.self, from: Data(contentsOf: file)); try verifyRecord(record, app: app)
        guard try paths.loadRecord(for: app) == nil else { throw fail("此应用已有托管备份，无需重复导入。") }
        let target = paths.root.appendingPathComponent("originals/\(UUID().uuidString)/Claude.original-bundle")
        try copyTree(URL(fileURLWithPath: record.backup), target); record.backup = target.path
        try verifyRecord(record, app: app); try paths.saveRecord(record, for: app)
        // Import an existing private installation into local settings only. The
        // release package never contains the previous user's credential.
        if let data = try? Asar(app.appendingPathComponent("Contents/Resources/app.asar")).read(bridgePrefix + "extension/private-config.js"), let source = String(data: data, encoding: .utf8), let regex = try? NSRegularExpression(pattern: "(?:[\"']apiKey[\"']|apiKey)\\s*:\\s*[\"'](sk-[A-Za-z0-9_-]+)[\"']"), let match = regex.firstMatch(in: source, range: NSRange(source.startIndex..., in: source)), let range = Range(match.range(at: 1), in: source) { return String(source[range]) }
        return nil
    }
    func recover(_ app: URL, progress: (String) -> Void) throws {
        try withLock(app) {try recoverUnlocked(app,progress:progress)}
    }
    private func recoverUnlocked(_ app: URL, progress: (String) -> Void) throws {
        try checkQuit(app); let url = journalURL(app)
        guard fm.fileExists(atPath: url.path) else { throw fail("没有需要恢复的中断操作。") }
        let job = try JSONDecoder().decode(Journal.self, from: Data(contentsOf: url)); guard job.app == app.standardizedFileURL.path else { throw fail("恢复记录与所选应用不匹配。") }
        let rollback = URL(fileURLWithPath: job.rollback)
        guard rollback.standardizedFileURL.path.hasPrefix(paths.root.standardizedFileURL.path + "/") else { throw fail("恢复目录超出补丁工具的工作区。") }
        for item in job.files {
            let live = try fileDigest(checkedPath(item.path, under: app)), old = try fileDigest(checkedPath(item.path, under: rollback))
            guard old == item.originalSHA256, live == item.originalSHA256 || live == item.installedSHA256 else { throw fail("应用或恢复备份已变化，自动恢复已停止。") }
        }
        if !job.committed {
            progress("恢复上次安装前的文件…")
            for item in job.files { try copyFileAtomically(checkedPath(item.path, under: rollback), checkedPath(item.path, under: app)) }
            if let previous = job.previousManifest { try privateWrite(previous, to: paths.record(for: app)) } else if fm.fileExists(atPath: paths.record(for: app).path) { try fm.removeItem(at: paths.record(for: app)) }
        }
        try fm.removeItem(at: url); try? fm.removeItem(at: rollback.deletingLastPathComponent())
    }
    func commit(_ replacements: [FileRecord], from source: URL, to app: URL, record: Installation?, progress: (String) -> Void) throws {
        try checkQuit(app); let journal = journalURL(app)
        guard !fm.fileExists(atPath: journal.path) else { throw fail("有未完成的安装，请先恢复中断操作。") }
        let rollback = paths.root.appendingPathComponent("rollback/\(UUID().uuidString)/Claude.previous-bundle")
        progress("保留当前应用以便回滚…"); try copyTree(app, rollback)
        let before = try replacements.map { item in FileRecord(path: item.path, originalSHA256: try fileDigest(checkedPath(item.path, under: app)), installedSHA256: item.installedSHA256) }
        var job = Journal(app: app.standardizedFileURL.path, rollback: rollback.path, files: before, previousManifest: try? Data(contentsOf: paths.record(for: app)))
        try privateWrite(jsonData(job), to: journal)
        do {
            try checkQuit(app); progress("写入已校验的补丁…")
            for item in replacements { try copyFileAtomically(checkedPath(item.path, under: source), checkedPath(item.path, under: app)) }
            for item in replacements { guard try fileDigest(checkedPath(item.path, under: app)) == item.installedSHA256 else { throw fail("写入后的文件校验失败。") } }
            if let record { try run("/usr/bin/codesign", ["--verify","--deep","--strict",app.path]); try paths.saveRecord(record, for: app) }
            else if fm.fileExists(atPath: paths.record(for: app).path) { try fm.removeItem(at: paths.record(for: app)) }
            job.committed = true; try privateWrite(jsonData(job), to: journal); try fm.removeItem(at: journal); try? fm.removeItem(at: rollback.deletingLastPathComponent())
        } catch {
            let cause = error.localizedDescription
            do { try recoverUnlocked(app, progress: progress) } catch { throw fail("安装未完成，恢复记录已保留。请使用“恢复中断操作”。\n\(cause)") }
            throw fail("操作未完成，已恢复安装前的文件。\n\(cause)")
        }
    }
    func stage(_ original: URL, into candidate: URL, progress: (String) -> Void) throws {
        progress("准备应用副本…"); try copyTree(original, candidate)
        let archiveURL = candidate.appendingPathComponent("Contents/Resources/app.asar"), archive = try Asar(archiveURL)
        var info = try appInfo(candidate)
        guard let integrity = info["ElectronAsarIntegrity"] as? [String: Any], let expected = integrity["Resources/app.asar"] as? [String: Any], expected["hash"] as? String == digest(archive.header) else { throw fail("原版应用资源校验失败。") }
        let entry = try archive.read(entryPath); guard entry.range(of: hook) == nil else { throw fail("需要未经修改的原版备份，不能在旧补丁上重复叠加。") }
        var replacements = [entryPath: hook + entry]
        for file in try regularFiles(bridge) { let name = try relative(file, under: bridge); replacements[bridgePrefix + name] = try Data(contentsOf: file) }
        replacements[bridgePrefix + "version.json"] = try JSONSerialization.data(withJSONObject: ["version": patchVersion], options: [.sortedKeys])
        progress("生成并校验资源补丁…"); let (patched, headerHash) = try archive.patched(replacements)
        try patched.write(to: archiveURL, options: .atomic)
        var updated = integrity, item = expected; item["hash"] = headerHash; updated["Resources/app.asar"] = item; info["ElectronAsarIntegrity"] = updated
        try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0).write(to: candidate.appendingPathComponent("Contents/Info.plist"), options: .atomic)
        try localSign(candidate, progress: progress)
    }
    func install(_ app: URL, config: Configuration, progress: (String) -> Void) throws {
        try withLock(app) {try installUnlocked(app,config:config,progress:progress)}
    }
    private func installUnlocked(_ app: URL, config: Configuration, progress: (String) -> Void) throws {
        try validate(config); guard !config.provider.apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw fail("请先填写 API Key 并保存设置。") }
        try checkQuit(app); let state = try status(app)
        guard supportedVersions.contains(state.version) else { throw fail("暂未验证 Claude \(state.version)，已停止安装。本版支持 3.1623.0。") }
        guard !state.interrupted else { throw fail("请先恢复上次中断的操作。") }
        let previous = try paths.loadRecord(for: app), original: URL
        if let previous { try verifyRecord(previous, app: app); original = URL(fileURLWithPath: previous.backup) }
        else {
            guard !state.patched else { throw fail("检测到已有补丁。请先导入现有的原版备份清单。") }
            original = paths.root.appendingPathComponent("originals/\(UUID().uuidString)/Claude.original-bundle")
            progress("备份原版 Claude…"); try copyTree(app, original)
        }
        let work = paths.root.appendingPathComponent("work/\(UUID().uuidString)"), candidate = work.appendingPathComponent("Claude.app")
        defer { try? fm.removeItem(at: work) }
        try stage(original, into: candidate, progress: progress)
        if let previous { try verifyRecord(previous, app: app) } else {
            guard try fileDigest(app.appendingPathComponent("Contents/Resources/app.asar")) == fileDigest(original.appendingPathComponent("Contents/Resources/app.asar")), try fileDigest(app.appendingPathComponent("Contents/Info.plist")) == fileDigest(original.appendingPathComponent("Contents/Info.plist")) else { throw fail("Claude 已在准备期间更新，已停止安装。") }
        }
        var files: [FileRecord] = []
        for file in try regularFiles(candidate) {
            let name = try relative(file, under: candidate), source = try checkedPath(name, under: original)
            guard fm.fileExists(atPath: source.path) else { throw fail("发现未验证的新应用组件，已停止安装。") }
            let old = try fileDigest(source), new = try fileDigest(file)
            if old != new { files.append(FileRecord(path: name, originalSHA256: old, installedSHA256: new)) }
        }
        let record = Installation(app: app.standardizedFileURL.path, backup: original.path, version: state.version, files: files, patchVersion: patchVersion, appLibraryMatchingException: true)
        try privateWrite(jsonData(config), to: paths.configuration)
        try commit(files, from: candidate, to: app, record: record, progress: progress)
    }
    func restore(_ app: URL, progress: (String) -> Void) throws {
        try withLock(app) {try restoreUnlocked(app,progress:progress)}
    }
    private func restoreUnlocked(_ app: URL, progress: (String) -> Void) throws {
        try checkQuit(app); guard let record = try paths.loadRecord(for: app) else { throw fail("没有找到此应用的原版备份。") }; try verifyRecord(record, app: app)
        let files = record.files.map { FileRecord(path: $0.path, originalSHA256: $0.installedSHA256, installedSHA256: $0.originalSHA256) }
        try commit(files, from: URL(fileURLWithPath: record.backup), to: app, record: nil, progress: progress)
    }
}
