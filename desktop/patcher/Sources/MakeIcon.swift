import AppKit
import Foundation

let output = URL(fileURLWithPath: CommandLine.arguments[1])
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
for (name, size) in [("icon_16x16",16),("icon_16x16@2x",32),("icon_32x32",32),("icon_32x32@2x",64),("icon_128x128",128),("icon_128x128@2x",256),("icon_256x256",256),("icon_256x256@2x",512),("icon_512x512",512),("icon_512x512@2x",1024)] {
    let pixels = CGFloat(size), rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let padding = pixels * 0.08, rect = NSRect(x: padding, y: padding, width: pixels - padding * 2, height: pixels - padding * 2)
    NSColor(calibratedWhite: 0.12, alpha: 1).setFill(); NSBezierPath(roundedRect: rect, xRadius: pixels * 0.19, yRadius: pixels * 0.19).fill()
    let label = NSAttributedString(string: "译", attributes: [.font: NSFont.systemFont(ofSize: pixels * 0.5, weight: .medium), .foregroundColor: NSColor(calibratedWhite: 0.96, alpha: 1)])
    let measured = label.size(); label.draw(at: NSPoint(x: (pixels - measured.width) / 2, y: (pixels - measured.height) / 2 + pixels * 0.015))
    NSGraphicsContext.restoreGraphicsState()
    try rep.representation(using: .png, properties: [:])!.write(to: output.appendingPathComponent(name + ".png"))
}
