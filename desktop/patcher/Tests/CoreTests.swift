import Foundation

func check(_ condition: @autoclosure () throws -> Bool, _ message: String) throws { guard try condition() else { throw fail("测试失败：" + message) } }
func expectFailure(_ label: String, _ work: () throws -> Void) throws { do { try work() } catch { return }; throw fail("测试未拒绝：" + label) }
func fakeApp(_ root: URL) throws -> URL {
    let app = root.appendingPathComponent("Claude.app"); try fm.createDirectory(at: app.appendingPathComponent("Contents"), withIntermediateDirectories: true)
    let info: [String: Any] = ["CFBundleIdentifier":"com.anthropic.claudefordesktop","CFBundleShortVersionString":"3.1623.0"]
    try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0).write(to: app.appendingPathComponent("Contents/Info.plist")); return app
}
@main struct CoreTests {
    static func main() throws {
        let args = CommandLine.arguments
        if args.count == 5 && args[1] == "--integration" {
            let original = URL(fileURLWithPath: args[2]), payload = URL(fileURLWithPath: args[3]), work = URL(fileURLWithPath: args[4])
            guard !fm.fileExists(atPath: work.path) else { throw fail("测试工作区已存在。") }
            try fm.createDirectory(at: work, withIntermediateDirectories: true)
            let app = work.appendingPathComponent("TestClaude.app"), before = try fileDigest(original.appendingPathComponent("Contents/Resources/app.asar"))
            try copyTree(original, app)
            let paths = Paths(root: work.appendingPathComponent("state"), configuration: work.appendingPathComponent("config.json")), installer = Installer(paths: paths, bridge: payload)
            var config = Configuration(); config.provider.apiKey = "sk-fixture-never-sent-to-a-service"
            try installer.install(app, config: config, progress: { print($0) })
            try check(installer.status(app).current, "安装版本标记")
            let record = try paths.loadRecord(for: app)!; try installer.verifyRecord(record, app: app)
            let archive = try Asar(app.appendingPathComponent("Contents/Resources/app.asar"))
            try check(archive.read(bridgePrefix + "extension/private-config.js") == Data("self.CztPrivateConfig={apiKey:''};\n".utf8), "安装包不得内置个人 Key")
            let patched = try fileDigest(app.appendingPathComponent("Contents/Resources/app.asar")); config.features.code = false; config.provider.model = "different-model"
            try privateWrite(jsonData(config), to: paths.configuration)
            try check(fileDigest(app.appendingPathComponent("Contents/Resources/app.asar")) == patched, "配置更新不得修改应用或重签名")
            let liveFile = app.appendingPathComponent("Contents/Resources/app.asar"), good = try Data(contentsOf: liveFile)
            var altered = good; altered[altered.count - 1] ^= 1; try altered.write(to: liveFile)
            try expectFailure("官方更新覆盖保护") { try installer.restore(app, progress: { _ in }) }; try good.write(to: liveFile)
            try installer.restore(app, progress: { print($0) })
            try check(fileDigest(app.appendingPathComponent("Contents/Resources/app.asar")) == before, "恢复必须字节一致")
            for item in record.files { try check(fileDigest(app.appendingPathComponent(item.path)) == item.originalSHA256, "恢复原签名和资源") }
            try check(fm.fileExists(atPath: paths.configuration.path), "恢复不得删除个人设置")
            print("PASS integration: native install, strict signatures, private payload, live settings isolation, update protection, byte-exact restore")
            return
        }
        let root = fm.temporaryDirectory.appendingPathComponent("czt-native-tests-\(UUID().uuidString)"); try fm.createDirectory(at: root, withIntermediateDirectories: true); defer { try? fm.removeItem(at: root) }
        try check(digest(Data("abc".utf8)) == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "SHA-256")
        var config = Configuration(); try validate(config)
        for invalid in ["http://example.com","https://secret@example.com","https://example.com/?key=secret"] { config.provider.baseURL = invalid; try expectFailure("不安全接口地址") { try validate(config) } }
        let privateFile = root.appendingPathComponent("private/settings.json"); try privateWrite(Data("settings".utf8), to: privateFile)
        try check((try fm.attributesOfItem(atPath: privateFile.path)[.posixPermissions] as? NSNumber)?.intValue == 0o600, "设置文件权限")
        let defaults = root.appendingPathComponent("PrivateDefaults.json"), preferences = root.appendingPathComponent("saved-config.json")
        var personal = Configuration(); personal.provider.apiKey = "sk-fixture-private-default"; try privateWrite(jsonData(personal), to: defaults)
        try check(loadConfiguration(saved: preferences, bundled: defaults).provider.apiKey == personal.provider.apiKey, "自用内置 Key")
        personal.provider.apiKey = "sk-fixture-user-replacement"; try privateWrite(jsonData(personal), to: preferences)
        try check(loadConfiguration(saved: preferences, bundled: defaults).provider.apiKey == personal.provider.apiKey, "用户自定义 Key 优先")
        try Data("corrupt".utf8).write(to: preferences); try expectFailure("损坏的设置不得被内置配置覆盖") { _ = try loadConfiguration(saved: preferences, bundled: defaults) }
        let app = try fakeApp(root), paths = Paths(root: root.appendingPathComponent("state"), configuration: root.appendingPathComponent("config.json")), worker = Installer(paths: paths, bridge: root)
        try expectFailure("备份路径穿越") { _ = try checkedPath("../other", under: app) }
        try expectFailure("绝对路径") { _ = try checkedPath("/etc/passwd", under: app) }
        let rollback = paths.root.appendingPathComponent("rollback/test/Claude.previous-bundle"); try copyTree(app, rollback)
        let file = app.appendingPathComponent("Contents/value"); try Data("before".utf8).write(to: rollback.appendingPathComponent("Contents/value")); try Data("after".utf8).write(to: file)
        let job = Journal(app: app.path, rollback: rollback.path, files: [FileRecord(path: "Contents/value", originalSHA256: digest(Data("before".utf8)), installedSHA256: digest(Data("after".utf8)))])
        try privateWrite(jsonData(job), to: worker.journalURL(app)); try worker.recover(app, progress: { _ in })
        try check(Data(contentsOf: file) == Data("before".utf8), "中断恢复")
        try check(!fm.fileExists(atPath: worker.journalURL(app).path), "恢复事务清理")
        print("PASS native unit: digest, URL validation, private storage, path isolation, interrupted-operation recovery")
    }
}
