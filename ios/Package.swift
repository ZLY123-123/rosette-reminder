// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ReminderCore",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "ReminderCore", targets: ["ReminderCore"])],
    targets: [
        .target(name: "ReminderCore", path: "Core"),
        .testTarget(name: "ReminderCoreTests", dependencies: ["ReminderCore"], path: "Tests")
    ]
)
