import SwiftUI
import AppKit
import UniformTypeIdentifiers

final class NoRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
enum Pane: String, CaseIterable { case install = "安装", translation = "翻译", provider = "接口"
    var symbol: String { switch self { case .install: return "arrow.down.app"; case .translation: return "character.bubble"; case .provider: return "key.horizontal" } }
}
final class Model: ObservableObject {
    @Published var pane: Pane = .install
    @Published var appPath = "/Applications/Claude.app"
    @Published var config = Configuration()
    @Published var status: PatchStatus?
    @Published var busy = false
    @Published var progress = ""
    @Published var notice = ""
    @Published var error = ""
    @Published var cacheSummary = ""
    @Published var testing = false
    let paths = Paths()
    var app: URL { URL(fileURLWithPath: appPath).standardizedFileURL }
    var installer: Installer { Installer(paths: paths, bridge: Bundle.main.resourceURL!.appendingPathComponent("Bridge")) }
    init() {
        if let data = try? Data(contentsOf: paths.preferences), let saved = try? JSONSerialization.jsonObject(with: data) as? [String: String], let selected = saved["app"] { appPath = selected }
        var configError = ""
        do { config = try loadConfiguration(saved: paths.configuration, bundled: nil) }
        catch { configError = "现有设置无法读取，请检查后重新保存；未自动覆盖。" }
        refresh(); if !configError.isEmpty { error = configError }
    }
    func refresh() {
        guard !busy else { return }
        do { status = try installer.status(app); error = "" } catch { status = nil; self.error = error.localizedDescription }
        if let data = try? Data(contentsOf: paths.cache), let values = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            let count = values.keys.filter { $0.hasPrefix("czt-cache-v1:segment:") && (values[$0] as? [String: Any])?["state"] as? String == "done" }.count
            cacheSummary = "已保留 \(count) 个翻译片段 · \(ByteCountFormatter.string(fromByteCount: Int64(data.count), countStyle: .file))"
        } else { cacheSummary = "翻译结果保存在本机，重启后继续使用。" }
    }
    func chooseApp() {
        let panel = NSOpenPanel(); panel.title = "选择 Claude Desktop"; panel.allowedContentTypes = [.applicationBundle]; panel.canChooseDirectories = false; panel.allowsMultipleSelection = false; panel.directoryURL = URL(fileURLWithPath: "/Applications")
        if panel.runModal() == .OK, let selected = panel.url {
            do { _ = try appInfo(selected); appPath = selected.standardizedFileURL.path; try privateWrite(JSONSerialization.data(withJSONObject: ["app": appPath]), to: paths.preferences); refresh() } catch { self.error = error.localizedDescription }
        }
    }
    func save() {
        do { var clean = config; clean.patcherPath = Bundle.main.bundleURL.path; clean.provider.apiKey = clean.provider.apiKey.trimmingCharacters(in: .whitespacesAndNewlines); clean.provider.baseURL = clean.provider.baseURL.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "/+$", with: "", options: .regularExpression); clean.provider.model = clean.provider.model.trimmingCharacters(in: .whitespacesAndNewlines); try validate(clean); try privateWrite(jsonData(clean), to: paths.configuration); config = clean; notice = status?.current == true ? "已保存，Claude 中自动生效。" : "已保存。安装新版补丁后生效。"; error = "" } catch { self.error = error.localizedDescription }
    }
    func operation(_ work: @escaping (Installer, URL, Configuration, @escaping (String) -> Void) throws -> Void, success: String) {
        guard !busy else { return }; busy = true; notice = ""; error = ""; progress = "正在准备…"
        var settings = config; settings.patcherPath = Bundle.main.bundleURL.path
        let worker = installer, target = app
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                try work(worker, target, settings, { phase in DispatchQueue.main.async { self.progress = phase } })
                DispatchQueue.main.async { self.busy = false; self.progress = ""; self.notice = success; self.refresh() }
            } catch { let message = error.localizedDescription; DispatchQueue.main.async { self.busy = false; self.progress = ""; self.error = message; self.refreshPreservingError() } }
        }
    }
    func refreshPreservingError() { let saved = error; refresh(); error = saved }
    func install() {
        do { try validate(config); try checkQuit(app) } catch { self.error = error.localizedDescription; return }
        guard !config.provider.apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { pane = .provider; error = "请先填写 API Key。"; return }
        let alert = NSAlert(); alert.messageText = status?.patched == true ? "更新所选 Claude 的补丁？" : "安装到所选 Claude？"
        alert.informativeText = "将保留完整原版备份，并替换为本地签名。仅对这份 Claude 添加动态库签名匹配例外，可能触发 macOS 钥匙串确认。SIP、Gatekeeper 和资源完整性校验保持启用。"
        alert.addButton(withTitle: "安装"); alert.addButton(withTitle: "取消"); alert.alertStyle = .warning
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        operation({ installer, target, config, progress in try installer.install(target, config: config, progress: progress) }, success: "安装完成。可打开 Claude；系统授权窗口请亲自处理。")
    }
    func restore() {
        let alert = NSAlert(); alert.messageText = "恢复所选 Claude 的原版？"; alert.informativeText = "恢复原始应用和签名。账号、聊天记录与翻译缓存会保留。请先退出 Claude。"; alert.addButton(withTitle: "恢复原版"); alert.addButton(withTitle: "取消")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        operation({ worker, target, _, progress in try worker.restore(target, progress: progress) }, success: "已恢复原版，聊天记录和翻译缓存已保留。")
    }
    func importBackup() {
        let panel = NSOpenPanel(); panel.title = "导入旧补丁的备份清单"; panel.allowedContentTypes = [.json]; panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let file = panel.url else { return }
        let worker = installer, target = app; busy = true; error = ""; progress = "校验并接管现有备份…"
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let key = try worker.importRecord(file, for: target)
                DispatchQueue.main.async { if self.config.provider.apiKey.isEmpty, let key { self.config.provider.apiKey = key }; self.busy = false; self.progress = ""; self.notice = "备份已接管，现有应用未改变。"; self.refresh() }
            } catch { let text = error.localizedDescription; DispatchQueue.main.async { self.busy = false; self.progress = ""; self.error = text } }
        }
    }
    func testConnection() {
        do { try validate(config) } catch { self.error = error.localizedDescription; return }
        guard !config.provider.apiKey.isEmpty else { error = "请填写 API Key。"; return }
        testing = true; notice = ""; error = ""
        let selected = config.provider
        DispatchQueue.global(qos: .userInitiated).async {
            let base = selected.baseURL.replacingOccurrences(of: "/+$", with: "", options: .regularExpression)
            var request = URLRequest(url: URL(string: base + "/models")!); request.timeoutInterval = 15; request.setValue("Bearer \(selected.apiKey)", forHTTPHeaderField: "Authorization")
            let session = URLSession(configuration: .ephemeral, delegate: NoRedirect(), delegateQueue: nil)
            session.dataTask(with: request) { data, response, networkError in
                let code = (response as? HTTPURLResponse)?.statusCode ?? 0
                let json = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }, models = json?["data"] as? [[String: Any]] ?? []
                DispatchQueue.main.async { self.testing = false
                    if networkError != nil { self.error = "无法连接接口，请检查地址和网络。" }
                    else if code != 200 { self.error = "接口返回 HTTP \(code)，请检查地址和 Key。" }
                    else if !models.contains(where: { $0["id"] as? String == selected.model }) { self.error = "连接成功，但接口未列出所填模型。请核对模型名称。" }
                    else { self.notice = "连接正常，模型可用。未发送翻译请求。" }
                }; session.finishTasksAndInvalidate()
            }.resume()
        }
    }
}
struct ContentView: View {
    @StateObject private var model = Model()
    var body: some View {
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 28) {
                VStack(alignment: .leading, spacing: 6) { Text("中文桥").font(.system(size: 25, weight: .semibold)); Text("Claude Desktop").font(.system(size: 11)).foregroundStyle(.secondary) }.padding(.top, 15)
                VStack(spacing: 5) { ForEach(Pane.allCases, id: \.self) { pane in
                    Button { withAnimation(.easeOut(duration: 0.14)) { model.pane = pane; model.notice = ""; model.error = "" } } label: { Label(pane.rawValue, systemImage: pane.symbol).font(.system(size: 13, weight: model.pane == pane ? .medium : .regular)).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 11).padding(.vertical, 10).background(model.pane == pane ? Color.primary.opacity(0.075) : Color.clear, in: RoundedRectangle(cornerRadius: 7)) }.buttonStyle(.plain)
                } }
                Spacer(); Text("版本 \(patchVersion)").font(.system(size: 10)).foregroundStyle(.tertiary)
            }.padding(22).frame(width: 168).background(Color(nsColor: .underPageBackgroundColor))
            Divider()
            VStack(alignment: .leading, spacing: 0) {
                HStack { Text(model.pane.rawValue).font(.system(size: 25, weight: .semibold)); Spacer(); if model.pane == .install { Button { model.refresh() } label: { Image(systemName: "arrow.clockwise") }.buttonStyle(.plain).help("重新检测") } }.padding(.bottom, 28)
                Group { switch model.pane { case .install: installPane; case .translation: translationPane; case .provider: providerPane } }.id(model.pane).transition(.opacity)
                Spacer(minLength: 18)
                if model.busy { HStack(spacing: 10) { ProgressView().controlSize(.small); Text(model.progress).font(.system(size: 12)).foregroundStyle(.secondary) }.padding(.bottom, 14) }
                if !model.error.isEmpty { Text(model.error).font(.system(size: 12)).foregroundStyle(.red).textSelection(.enabled).fixedSize(horizontal: false, vertical: true).padding(.bottom, 14) }
                else if !model.notice.isEmpty { Text(model.notice).font(.system(size: 12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true).padding(.bottom, 14) }
                Divider().padding(.bottom, 17)
                footer
            }.padding(32).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }.frame(minWidth: 800, idealWidth: 830, maxWidth: 1000, minHeight: 620, idealHeight: 660).disabled(model.busy)
    }
    var installPane: some View {
        VStack(alignment: .leading, spacing: 22) {
            HStack(spacing: 14) {
                Image(nsImage: NSWorkspace.shared.icon(forFile: model.appPath)).resizable().frame(width: 46, height: 46)
                VStack(alignment: .leading, spacing: 5) { Text("Claude").font(.system(size: 16, weight: .medium)); Text(model.status.map { "\($0.version) · \($0.patched ? ($0.current ? "已安装" : "可升级旧补丁") : "未安装补丁")" } ?? "请选择 Claude Desktop").font(.system(size: 12)).foregroundStyle(.secondary) }
                Spacer(); Button("选择…") { model.chooseApp() }
            }
            Text(model.appPath).font(.system(size: 11)).foregroundStyle(.tertiary).lineLimit(1).truncationMode(.middle).textSelection(.enabled)
            Divider()
            VStack(alignment: .leading, spacing: 13) {
                Text("安装后，翻译设置可独立修改。").font(.system(size: 13))
                Text("保留原版备份与聊天记录。官方更新后先检查兼容性，避免覆盖新版应用。").font(.system(size: 12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            if let state = model.status, state.patched && !state.managed {
                VStack(alignment: .leading, spacing: 10) { Text("检测到现有补丁").font(.system(size: 13, weight: .medium)); Text("先导入旧补丁的原版备份清单，再由此工具管理。").font(.system(size: 12)).foregroundStyle(.secondary); Button("导入备份清单…") { model.importBackup() } }
            }
            if let state = model.status, !supportedVersions.contains(state.version) { Text("本版已验证 Claude 3.1623.0。所选版本暂不支持安装。").font(.system(size: 12)).foregroundStyle(.secondary) }
            if model.status?.interrupted == true { Button("恢复中断操作") { model.operation({ worker, app, _, progress in try worker.recover(app, progress: progress) }, success: "中断操作已处理，原有数据已保留。") } }
        }
    }
    func toggleRow(_ title: String, detail: String, value: Binding<Bool>) -> some View {
        HStack { VStack(alignment: .leading, spacing: 4) { Text(title).font(.system(size: 13)); Text(detail).font(.system(size: 11)).foregroundStyle(.secondary) }; Spacer(); Toggle(title, isOn: value).labelsHidden().toggleStyle(.switch).controlSize(.small).tint(.primary) }.padding(.vertical, 11)
    }
    var translationPane: some View {
        VStack(alignment: .leading, spacing: 0) {
            toggleRow("输入文字", detail: "中文译成英文后发送", value: $model.config.features.input); Divider()
            toggleRow("消息与回复", detail: "英文显示为中文，保留原文入口", value: $model.config.features.output); Divider()
            toggleRow("会话标题", detail: "侧栏标题显示中文", value: $model.config.features.titles)
            HStack(spacing: 26) { Text("生效范围").foregroundStyle(.secondary); Toggle("Chat", isOn: $model.config.features.chat); Toggle("Code", isOn: $model.config.features.code); Spacer() }.font(.system(size: 12)).padding(.top, 29)
            Text(model.cacheSummary).font(.system(size: 11)).foregroundStyle(.tertiary).padding(.top, 28)
        }
    }
    var providerPane: some View {
        VStack(alignment: .leading, spacing: 19) {
            VStack(alignment: .leading, spacing: 8) { Text("API Key").font(.system(size: 12, weight: .medium)); SecureField("填写自己的 API Key", text: $model.config.provider.apiKey).textFieldStyle(.roundedBorder) }
            VStack(alignment: .leading, spacing: 8) { Text("接口地址").font(.system(size: 12, weight: .medium)); TextField("https://api.deepseek.com", text: $model.config.provider.baseURL).textFieldStyle(.roundedBorder) }
            VStack(alignment: .leading, spacing: 8) { Text("模型").font(.system(size: 12, weight: .medium)); TextField("deepseek-flash", text: $model.config.provider.model).textFieldStyle(.roundedBorder) }
            HStack { Text("思考已关闭").font(.system(size: 11)).foregroundStyle(.secondary); Spacer(); Button(model.testing ? "检查中…" : "测试连接") { model.testConnection() }.disabled(model.testing) }
            Text("Key 只保存在本机。消息会发往你配置的接口进行翻译。").font(.system(size: 11)).foregroundStyle(.tertiary).fixedSize(horizontal: false, vertical: true).padding(.top, 4)
        }
    }
    var footer: some View {
        HStack {
            if model.pane == .install {
                Button(model.status?.patched == true ? "更新补丁" : "安装补丁") { model.install() }.buttonStyle(.borderedProminent).disabled(model.status == nil || model.status?.interrupted == true || !(supportedVersions.contains(model.status?.version ?? "")) || (model.status?.patched == true && model.status?.managed != true))
                if model.status?.managed == true { Button("恢复原版") { model.restore() } }
                Spacer(); Button("打开 Claude") { NSWorkspace.shared.openApplication(at: model.app, configuration: NSWorkspace.OpenConfiguration()) { _, _ in } }
            } else { Button("保存设置") { model.save() }.buttonStyle(.borderedProminent); Spacer() }
        }.controlSize(.large)
    }
}
@main struct PatcherApplication: App {
    var body: some Scene { Window("Claude 中文桥", id: "main") { ContentView() }.defaultSize(width: 830, height: 660).windowResizability(.contentMinSize) }
}
