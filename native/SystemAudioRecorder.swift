import Foundation
import ScreenCaptureKit
import AVFoundation

final class AudioFileWriter {
    private let writer: AVAssetWriter
    private let input: AVAssetWriterInput
    private var started = false

    init(url: URL, channels: Int = 2) throws {
        self.writer = try AVAssetWriter(outputURL: url, fileType: .m4a)
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 48_000,
            AVNumberOfChannelsKey: channels,
            AVEncoderBitRateKey: 128_000
        ]
        self.input = AVAssetWriterInput(mediaType: .audio, outputSettings: settings)
        self.input.expectsMediaDataInRealTime = true
        if writer.canAdd(input) {
            writer.add(input)
        }
    }

    func append(_ sampleBuffer: CMSampleBuffer) {
        guard CMSampleBufferDataIsReady(sampleBuffer) else { return }
        if !started {
            writer.startWriting()
            writer.startSession(atSourceTime: CMSampleBufferGetPresentationTimeStamp(sampleBuffer))
            started = true
        }
        if input.isReadyForMoreMediaData {
            input.append(sampleBuffer)
        }
    }

    func finish() async {
        guard started else { return }
        input.markAsFinished()
        await writer.finishWriting()
    }
}

final class SystemAudioRecorder: NSObject, SCStreamDelegate, SCStreamOutput {
    private var stream: SCStream?
    private let systemWriter: AudioFileWriter
    private let microphoneWriter: AudioFileWriter?
    private let stopFile: URL
    private var didStop = false

    init(outputDir: URL, includeMicrophone: Bool) throws {
        try FileManager.default.createDirectory(at: outputDir, withIntermediateDirectories: true)
        self.systemWriter = try AudioFileWriter(url: outputDir.appendingPathComponent("system-audio.m4a"), channels: 2)
        if includeMicrophone {
            self.microphoneWriter = try AudioFileWriter(url: outputDir.appendingPathComponent("microphone-audio.m4a"), channels: 1)
        } else {
            self.microphoneWriter = nil
        }
        self.stopFile = outputDir.appendingPathComponent("STOP")
    }

    func start(includeMicrophone: Bool) async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first else {
            throw RuntimeError("No display available for ScreenCaptureKit.")
        }

        let filter = SCContentFilter(display: display, excludingWindows: [])
        let config = SCStreamConfiguration()
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        config.queueDepth = 3
        config.capturesAudio = true
        config.excludesCurrentProcessAudio = true
        config.sampleRate = 48_000
        config.channelCount = 2

        if #available(macOS 15.0, *) {
            config.captureMicrophone = includeMicrophone
        }

        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: DispatchQueue(label: "system-audio"))
        if #available(macOS 15.0, *), includeMicrophone {
            try stream.addStreamOutput(self, type: .microphone, sampleHandlerQueue: DispatchQueue(label: "microphone-audio"))
        }
        self.stream = stream
        try await stream.startCapture()
        print("SYSTEM_AUDIO_RECORDER_STARTED")
        fflush(stdout)

        while !didStop {
            if FileManager.default.fileExists(atPath: stopFile.path) {
                didStop = true
                break
            }
            try await Task.sleep(nanoseconds: 300_000_000)
        }

        try await stop()
    }

    func stop() async throws {
        try await stream?.stopCapture()
        await systemWriter.finish()
        await microphoneWriter?.finish()
        print("SYSTEM_AUDIO_RECORDER_STOPPED")
        fflush(stdout)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        fputs("SYSTEM_AUDIO_RECORDER_ERROR: \(error.localizedDescription)\n", stderr)
        didStop = true
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        switch outputType {
        case .audio:
            systemWriter.append(sampleBuffer)
        default:
            if #available(macOS 15.0, *), outputType == .microphone {
                microphoneWriter?.append(sampleBuffer)
            }
        }
    }
}

struct RuntimeError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) {
        self.description = description
    }
}

@main
struct Main {
    static func main() async {
        do {
            let args = CommandLine.arguments
            guard args.count >= 2 else {
                throw RuntimeError("Usage: SystemAudioRecorder <output-dir> [--microphone]")
            }
            let outputDir = URL(fileURLWithPath: args[1], isDirectory: true)
            let includeMicrophone = args.contains("--microphone")
            let recorder = try SystemAudioRecorder(outputDir: outputDir, includeMicrophone: includeMicrophone)
            try await recorder.start(includeMicrophone: includeMicrophone)
        } catch {
            fputs("SYSTEM_AUDIO_RECORDER_FATAL: \(error)\n", stderr)
            exit(1)
        }
    }
}
