import Foundation
import AVFoundation

struct RuntimeError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) {
        self.description = description
    }
}

func valueAfter(_ flag: String, in args: [String]) -> String? {
    guard let index = args.firstIndex(of: flag), args.indices.contains(index + 1) else {
        return nil
    }
    return args[index + 1]
}

do {
    let args = CommandLine.arguments
    guard
        let inputPath = valueAfter("--input", in: args),
        let outputPath = valueAfter("--output", in: args),
        let startValue = valueAfter("--start", in: args).flatMap(Double.init),
        let endValue = valueAfter("--end", in: args).flatMap(Double.init)
    else {
        throw RuntimeError("Usage: AudioClipper --input <audio-file> --output <clip.m4a> --start <seconds> --end <seconds>")
    }

    let inputURL = URL(fileURLWithPath: inputPath)
    let outputURL = URL(fileURLWithPath: outputPath)
    try? FileManager.default.removeItem(at: outputURL)
    try FileManager.default.createDirectory(at: outputURL.deletingLastPathComponent(), withIntermediateDirectories: true)

    let source = try AVAudioFile(forReading: inputURL)
    let format = source.processingFormat
    let sampleRate = format.sampleRate
    let startFrame = max(0, AVAudioFramePosition(startValue * sampleRate))
    let endFrame = min(source.length, AVAudioFramePosition(max(startValue + 0.5, endValue) * sampleRate))
    let frameCount = AVAudioFrameCount(max(0, endFrame - startFrame))
    guard frameCount > 0 else {
        throw RuntimeError("Audio clip duration is empty.")
    }

    source.framePosition = startFrame
    guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount) else {
        throw RuntimeError("Could not allocate audio buffer.")
    }
    try source.read(into: buffer, frameCount: frameCount)

    let settings: [String: Any] = [
        AVFormatIDKey: kAudioFormatMPEG4AAC,
        AVSampleRateKey: sampleRate,
        AVNumberOfChannelsKey: Int(format.channelCount),
        AVEncoderBitRateKey: 96000
    ]
    let output = try AVAudioFile(forWriting: outputURL, settings: settings)
    try output.write(from: buffer)
    print(outputURL.path)
} catch {
    fputs("AUDIO_CLIPPER_FATAL: \(error)\n", stderr)
    exit(1)
}
