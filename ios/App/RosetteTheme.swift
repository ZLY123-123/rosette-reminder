import SwiftUI
import UIKit

enum RosetteTypography {
    static func wordmark(size: CGFloat, relativeTo style: Font.TextStyle) -> Font {
        .custom("CabinSketch-Regular", size: size, relativeTo: style)
    }

    static let motto = Font.custom("Italianno-Regular", size: 38, relativeTo: .title3)
}

enum RosettePalette {
    static let canvas = adaptive(0xFDF0F4, 0x281D26)
    static let panel = adaptive(0xFFFBFC, 0x342733)
    static let edge = adaptive(0xE9CDD9, 0x5E4051)
    static let roseAccent = adaptive(0x9A4167, 0xF3A9C6)
    static let onRoseAccent = adaptive(0xFFFFFF, 0x351826)
    static let roseWash = adaptive(0xF8DFE9, 0x443147)
    static let orchid = adaptive(0x63477C, 0xCDACEB)
    static let orchidWash = adaptive(0xF0E6F6, 0x352842)
    static let amber = adaptive(0x884721, 0xFAB78C)
    static let amberWash = adaptive(0xFAEBDD, 0x443448)
    static let petalWash = adaptive(0xFCEEF2, 0x392733)
    static let roseGlow = adaptive(0xF4C8D9, 0x60384F)

    static func providerName(_ id: String) -> String {
        switch id.lowercased() {
        case "deepseek": "DeepSeek"
        case "openai": "OpenAI"
        case "openrouter": "OpenRouter"
        case "anthropic": "Anthropic"
        case "google": "Google Gemini"
        case "minimax": "MiniMax"
        case "qwen": "Qwen"
        case "moonshot": "Moonshot"
        default: id
        }
    }

    private static func adaptive(_ light: UInt32, _ dark: UInt32) -> Color {
        Color(uiColor: UIColor { traits in
            let code = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: CGFloat((code >> 16) & 255) / 255,
                green: CGFloat((code >> 8) & 255) / 255, blue: CGFloat(code & 255) / 255, alpha: 1)
        })
    }
}

struct RosetteSegmentedPicker<Value: Hashable>: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    private let title: String
    @Binding var selection: Value
    private let options: [Value]
    private let label: (Value) -> String

    init(_ title: String, selection: Binding<Value>, options: [Value], label: @escaping (Value) -> String) {
        self.title = title
        _selection = selection
        self.options = options
        self.label = label
    }

    var body: some View {
        if colorScheme == .dark {
            let layout = dynamicTypeSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(spacing: 4))
                : AnyLayout(HStackLayout(spacing: 4))
            layout {
                ForEach(options, id: \.self) { option in
                    let selected = selection == option
                    Button { selection = option } label: {
                        Text(label(option))
                            .font(.subheadline.weight(selected ? .semibold : .regular))
                            .multilineTextAlignment(.center)
                            .frame(maxWidth: .infinity, minHeight: 44)
                            .background {
                                if selected {
                                    RoundedRectangle(cornerRadius: 10).fill(RosettePalette.edge)
                                }
                            }
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(selected ? [.isSelected] : [])
                }
            }
            .padding(4)
            .background(RosettePalette.roseWash, in: RoundedRectangle(cornerRadius: 14))
            .accessibilityElement(children: .contain)
            .accessibilityLabel(title)
        } else {
            Picker(title, selection: $selection) {
                ForEach(options, id: \.self) { option in
                    Text(label(option)).tag(option)
                }
            }
            .pickerStyle(.segmented)
        }
    }
}

struct RosetteBackdrop: View {
    var body: some View {
        ZStack {
            RosettePalette.canvas
            RadialGradient(colors: [RosettePalette.roseGlow.opacity(0.42), .clear],
                center: .topTrailing, startRadius: 0, endRadius: 390)
            RadialGradient(colors: [RosettePalette.petalWash.opacity(0.45), .clear],
                center: .bottomLeading, startRadius: 18, endRadius: 410)
        }
        .ignoresSafeArea()
        .accessibilityHidden(true)
    }
}

extension View {
    func rosetteList() -> some View {
        scrollContentBackground(.hidden).background { RosetteBackdrop() }
    }

    func rosetteSurface(_ fill: Color = RosettePalette.panel, radius: CGFloat = 17) -> some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        return background(fill, in: shape)
            .overlay { shape.strokeBorder(RosettePalette.edge.opacity(0.68)).allowsHitTesting(false) }
    }
}
