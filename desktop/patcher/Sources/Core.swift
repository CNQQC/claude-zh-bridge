import Foundation
import CryptoKit
import AppKit

enum PatcherError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let text) = self { return text }; return nil }
}
let patchVersion = "1.6.0"
let supportedVersions: Set<String> = ["3.1623.0"]
let entryPath = ".vite/build/index.js"
let bridgePrefix = ".vite/build/czt-desktop/"
let hook = Data("require('./czt-desktop/main.cjs');\n".utf8)
let fm = FileManager.default
func fail(_ text: String) -> PatcherError { .message(text) }
func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
func fileDigest(_ url: URL) throws -> String {
    let handle = try FileHandle(forReadingFrom: url); defer { try? handle.close() }
    var hash = SHA256()
    while let chunk = try handle.read(upToCount: 4 * 1024 * 1024), !chunk.isEmpty { hash.update(data: chunk) }
    return hash.finalize().map { String(format: "%02x", $0) }.joined()
}
func jsonData<T: Encodable>(_ value: T) throws -> Data { let e = JSONEncoder(); e.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]; return try e.encode(value) }
func privateWrite(_ data: Data, to url: URL) throws {
    try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let temporary = url.deletingLastPathComponent().appendingPathComponent(".write-\(UUID().uuidString)")
    guard fm.createFile(atPath: temporary.path, contents: nil, attributes: [.posixPermissions: 0o600]) else { throw fail("无法保存设置。") }
    defer { try? fm.removeItem(at: temporary) }
    let handle = try FileHandle(forWritingTo: temporary); try handle.write(contentsOf: data); try handle.synchronize(); try handle.close()
    guard rename(temporary.path, url.path) == 0 else { throw fail("无法完成安全保存。") }
}
struct Provider: Codable, Equatable { var apiKey = ""; var baseURL = "https://api.deepseek.com"; var model = "deepseek-flash" }
struct Features: Codable, Equatable { var input = true; var output = true; var titles = true; var chat = true; var code = true }
struct Configuration: Codable, Equatable { var schemaVersion = 1; var provider = Provider(); var features = Features(); var patcherPath: String? }
func loadConfiguration(saved: URL, bundled: URL?) throws -> Configuration {
    let source = fm.fileExists(atPath: saved.path) ? saved : bundled
    guard let source else { return Configuration() }
    let result = try JSONDecoder().decode(Configuration.self, from: Data(contentsOf: source)); try validate(result); return result
}
struct FileRecord: Codable { var path: String; var originalSHA256: String; var installedSHA256: String }
struct Installation: Codable {
    var app: String; var backup: String; var version: String; var files: [FileRecord]
    var patchVersion: String?; var appLibraryMatchingException: Bool?
}
struct ProcessResult { var code: Int32; var output: String }
@discardableResult func run(_ executable: String, _ arguments: [String], requireSuccess: Bool = true) throws -> ProcessResult {
    let task = Process(); task.executableURL = URL(fileURLWithPath: executable); task.arguments = arguments
    let pipe = Pipe(); task.standardOutput = pipe; task.standardError = pipe
    try task.run(); let data = pipe.fileHandleForReading.readDataToEndOfFile(); task.waitUntilExit()
    let result = ProcessResult(code: task.terminationStatus, output: String(data: data, encoding: .utf8) ?? "")
    if requireSuccess && result.code != 0 { throw fail("本地操作失败（\(URL(fileURLWithPath: executable).lastPathComponent)，\(result.code)）。\n\(result.output.prefix(700))") }
    return result
}
func checkQuit(_ app: URL) throws {
    let pattern = NSRegularExpression.escapedPattern(for: app.appendingPathComponent("Contents/MacOS/Claude").path)
    let result = try run("/usr/bin/pgrep", ["-f", pattern], requireSuccess: false)
    guard result.code == 1 else { throw fail(result.code == 0 ? "请先完全退出 Claude，再执行此操作。未发送的草稿请先保留。" : "无法确认 Claude 已退出，操作已停止。") }
}
func appInfo(_ app: URL) throws -> [String: Any] {
    let data = try Data(contentsOf: app.appendingPathComponent("Contents/Info.plist"))
    guard let info = try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any], info["CFBundleIdentifier"] as? String == "com.anthropic.claudefordesktop" else { throw fail("请选择原版 Claude Desktop 应用。") }
    return info
}
func validate(_ config: Configuration) throws {
    guard let u = URLComponents(string: config.provider.baseURL), u.scheme == "https", let host = u.host, !host.isEmpty, u.user == nil, u.password == nil, u.query == nil, u.fragment == nil else { throw fail("接口地址需为 HTTPS，不能包含账号、密码或查询参数。") }
    guard config.provider.model.range(of: "^[A-Za-z0-9._:/-]{1,150}$", options: .regularExpression) != nil else { throw fail("请填写有效的模型名称。") }
    guard !config.provider.apiKey.contains("\n"), config.provider.apiKey.count <= 1000 else { throw fail("API Key 格式不正确。") }
}
struct Paths {
    var root: URL
    var configurationOverride: URL?
    init(root: URL? = nil, configuration: URL? = nil) { self.root = root ?? fm.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Claude 中文桥"); configurationOverride = configuration }
    var configuration: URL { configurationOverride ?? fm.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Claude/czt-desktop/config.json") }
    var cache: URL { configuration.deletingLastPathComponent().appendingPathComponent("cache.json") }
    var preferences: URL { root.appendingPathComponent("preferences.json") }
    func record(for app: URL) -> URL { root.appendingPathComponent("installations/\(digest(Data(app.standardizedFileURL.path.utf8))).json") }
    func loadRecord(for app: URL) throws -> Installation? {
        let url = record(for: app)
        guard fm.fileExists(atPath: url.path) else { return nil }
        return try JSONDecoder().decode(Installation.self, from: Data(contentsOf: url))
    }
    func saveRecord(_ value: Installation, for app: URL) throws { try privateWrite(jsonData(value), to: record(for: app)) }
}
struct Asar {
    var tree: [String: Any]; var bytes: Data; var start: Int; var header: Data
    init(_ url: URL) throws {
        bytes = try Data(contentsOf: url, options: .mappedIfSafe)
        guard bytes.count >= 16, try bytes.u32(0) == 4 else { throw fail("不支持的 Claude 资源格式。") }
        let length = Int(try bytes.u32(12)); start = 8 + Int(try bytes.u32(4))
        guard length > 0, length < 20_000_000, start <= bytes.count, 16 + length <= start else { throw fail("Claude 资源头无效。") }
        header = bytes.subdata(in: 16..<16 + length)
        guard let parsed = try JSONSerialization.jsonObject(with: header) as? [String: Any] else { throw fail("Claude 资源目录无法读取。") }; tree = parsed
    }
    func entries(_ node: [String: Any]? = nil, prefix: String = "") -> [(String, [String: Any])] {
        let files = (node ?? tree)["files"] as? [String: Any] ?? [:]
        return files.keys.sorted().flatMap { key -> [(String, [String: Any])] in
            guard let item = files[key] as? [String: Any] else { return [] }
            return item["files"] != nil ? entries(item, prefix: prefix + key + "/") : [(prefix + key, item)]
        }
    }
    func read(_ name: String) throws -> Data {
        guard let item = entries().first(where: { $0.0 == name })?.1, item["unpacked"] == nil, item["link"] == nil, let size = item["size"] as? Int, let offset = Int(item["offset"] as? String ?? ""), offset >= 0, size >= 0, start + offset + size <= bytes.count else { throw fail("缺少所需 Claude 资源：\(name)") }
        return bytes.subdata(in: start + offset..<start + offset + size)
    }
    static func set(_ node: inout [String: Any], parts: ArraySlice<String>, item: [String: Any]) {
        guard let name = parts.first else { return }; var files = node["files"] as? [String: Any] ?? [:]
        if parts.count == 1 { files[name] = item } else { var child = files[name] as? [String: Any] ?? ["files": [:]]; set(&child, parts: parts.dropFirst(), item: item); files[name] = child }; node["files"] = files
    }
    func patched(_ replacements: [String: Data]) throws -> (Data, String) {
        var updated = tree
        for (name, data) in replacements {
            let block = 4_194_304; var blocks: [String] = []
            for i in stride(from: 0, to: data.count, by: block) { blocks.append(digest(data.subdata(in: i..<min(i + block, data.count)))) }
            Asar.set(&updated, parts: name.split(separator: "/").map(String.init)[...], item: ["size": data.count, "offset": "0", "integrity": ["algorithm": "SHA256", "hash": digest(data), "blockSize": block, "blocks": blocks]])
        }
        var payload = Data()
        for (name, var item) in entries(updated) where item["unpacked"] == nil && item["link"] == nil {
            let content = try replacements[name] ?? read(name)
            if let integrity = item["integrity"] as? [String: Any], let expected = integrity["hash"] as? String, expected != digest(content) { throw fail("Claude 资源校验失败：\(name)") }
            item["offset"] = String(payload.count); Asar.set(&updated, parts: name.split(separator: "/").map(String.init)[...], item: item); payload.append(content)
        }
        let raw = try JSONSerialization.data(withJSONObject: updated, options: [.sortedKeys, .withoutEscapingSlashes])
        var inner = Data.le32(UInt32(raw.count)); inner.append(raw); while inner.count % 4 != 0 { inner.append(0) }
        var headerBlock = Data.le32(UInt32(inner.count)); headerBlock.append(inner)
        var result = Data.le32(4); result.append(Data.le32(UInt32(headerBlock.count))); result.append(headerBlock); result.append(payload)
        return (result, digest(raw))
    }
}
extension Data {
    func u32(_ at: Int, be: Bool = false) throws -> UInt32 { guard at >= 0, at + 4 <= count else { throw fail("应用签名数据不完整。") }; return (0..<4).reduce(0) { $0 | UInt32(self[at + $1]) << UInt32((be ? 3 - $1 : $1) * 8) } }
    func u64(_ at: Int, be: Bool = false) throws -> UInt64 { guard at >= 0, at + 8 <= count else { throw fail("应用签名数据不完整。") }; return (0..<8).reduce(0) { $0 | UInt64(self[at + $1]) << UInt64((be ? 7 - $1 : $1) * 8) } }
    static func le32(_ value: UInt32) -> Data { Data((0..<4).map { UInt8((value >> ($0 * 8)) & 255) }) }
}
struct SigningMetadata { var entitlements: [String: Any] = [:]; var runtime = false }
func signature(_ path: URL) throws -> SigningMetadata {
    let d = try Data(contentsOf: path, options: .mappedIfSafe); var start = 0
    let magic = try d.u32(0, be: true)
    if magic == 0xcafebabe || magic == 0xcafebabf {
        let fat64 = magic == 0xcafebabf, count = Int(try d.u32(4, be: true)); guard count <= 32 else { throw fail("不支持的应用二进制。") }
        for i in 0..<count { let at = 8 + i * (fat64 ? 32 : 20), cpu = try d.u32(at, be: true); let offset = fat64 ? Int(try d.u64(at + 8, be: true)) : Int(try d.u32(at + 8, be: true)); if i == 0 || cpu == 0x100000c { start = offset }; if cpu == 0x100000c { break } }
    }
    guard try d.u32(start) == 0xfeedfacf else { return SigningMetadata() }
    let commands = Int(try d.u32(start + 16)); guard commands < 20_000 else { throw fail("签名目录无效。") }; var at = start + 32
    for _ in 0..<commands {
        let command = try d.u32(at), length = Int(try d.u32(at + 4)); guard length >= 8 else { throw fail("签名命令无效。") }
        if command == 0x1d {
            let offset = start + Int(try d.u32(at + 8)), count = Int(try d.u32(offset + 8, be: true)); guard count < 1000 else { throw fail("签名槽位无效。") }; var result = SigningMetadata()
            for i in 0..<count {
                let slot = try d.u32(offset + 12 + i * 8, be: true), pos = offset + Int(try d.u32(offset + 16 + i * 8, be: true))
                if slot == 0 { result.runtime = try d.u32(pos + 12, be: true) & 0x10000 != 0 }
                if slot == 5 { let size = Int(try d.u32(pos + 4, be: true)); guard size >= 8, pos + size <= d.count else { throw fail("应用权限数据无效。") }; result.entitlements = try PropertyListSerialization.propertyList(from: d.subdata(in: pos + 8..<pos + size), format: nil) as? [String: Any] ?? [:] }
            }; return result
        }; at += length
    }; return SigningMetadata()
}
func localSign(_ app: URL, progress: (String) -> Void) throws {
    let keys: [URLResourceKey] = [.isRegularFileKey, .isSymbolicLinkKey, .isDirectoryKey]
    guard let enumerator = fm.enumerator(at: app, includingPropertiesForKeys: keys) else { throw fail("无法检查应用文件。") }
    var binaries: [URL] = [], bundles: [URL] = [], metadata: [String: SigningMetadata] = [:]
    for case let p as URL in enumerator {
        let values = try p.resourceValues(forKeys: Set(keys)); if values.isSymbolicLink == true { continue }
        if values.isDirectory == true && ["app", "framework", "xpc"].contains(p.pathExtension) { bundles.append(p) }
        if values.isRegularFile == true {
            let handle = try FileHandle(forReadingFrom: p); let head = try handle.read(upToCount: 4) ?? Data(); try handle.close()
            if head.count == 4 { let magic = try head.u32(0, be: true); if [UInt32(0xcffaedfe),0xcefaedfe,0xcafebabe,0xbebafeca,0xcafebabf].contains(magic) { binaries.append(p); metadata[p.path] = try signature(p) } }
        }
    }
    guard !binaries.isEmpty else { throw fail("未找到 Claude 可执行组件。") }
    let temporary = app.deletingLastPathComponent().appendingPathComponent("sign-entitlements.plist")
    defer { try? fm.removeItem(at: temporary) }
    func sign(_ target: URL, _ info: SigningMetadata) throws {
        var entitlements = info.entitlements
        for key in ["com.apple.application-identifier","com.apple.developer.team-identifier","keychain-access-groups"] { entitlements.removeValue(forKey: key) }
        var arguments = ["--force", "--sign", "-", "--timestamp=none", "--generate-entitlement-der"]
        if info.runtime { arguments += ["--options","runtime"]; entitlements["com.apple.security.cs.disable-library-validation"] = true }
        if !entitlements.isEmpty { try PropertyListSerialization.data(fromPropertyList: entitlements, format: .xml, options: 0).write(to: temporary); arguments += ["--entitlements",temporary.path] }
        try run("/usr/bin/codesign", arguments + [target.path])
    }
    for p in binaries.sorted(by: { $0.pathComponents.count > $1.pathComponents.count }) { try sign(p, metadata[p.path] ?? SigningMetadata()) }
    for bundle in bundles.sorted(by: { $0.pathComponents.count > $1.pathComponents.count }) + [app] {
        var info = SigningMetadata()
        if bundle.pathExtension == "framework", let binary = binaries.first(where: { $0.path.hasPrefix(bundle.path + "/") && $0.lastPathComponent == bundle.deletingPathExtension().lastPathComponent }) { info = metadata[binary.path] ?? info }
        else if let data = try? Data(contentsOf: bundle.appendingPathComponent("Contents/Info.plist")), let plist = try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any], let executable = plist["CFBundleExecutable"] as? String { info = metadata[bundle.appendingPathComponent("Contents/MacOS/" + executable).path] ?? info }
        try sign(bundle, info)
    }
    progress("校验本地签名…"); try run("/usr/bin/codesign", ["--verify","--deep","--strict",app.path])
}
