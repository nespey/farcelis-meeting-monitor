import Foundation
import AVFoundation
import Speech

struct RuntimeError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) {
        self.description = description
    }
}

final class Transcriber {
    private let locale: Locale
    private let onDevice: Bool

    init(localeIdentifier: String, onDevice: Bool) {
        self.locale = Locale(identifier: localeIdentifier)
        self.onDevice = onDevice
    }

    func requestAuthorization() async throws {
        let status = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status)
            }
        }

        guard status == .authorized else {
            throw RuntimeError("Speech recognition permission is \(status.rawValue). Grant Speech Recognition permission in macOS Settings, then try again.")
        }
    }

    func transcribe(url: URL) async throws -> String {
        guard let recognizer = SFSpeechRecognizer(locale: locale) else {
            throw RuntimeError("No speech recognizer is available for locale \(locale.identifier).")
        }
        guard recognizer.isAvailable else {
            throw RuntimeError("Speech recognizer is not currently available.")
        }
        if onDevice && !recognizer.supportsOnDeviceRecognition {
            throw RuntimeError("On-device speech recognition is not available for \(locale.identifier) on this Mac.")
        }

        let file = try AVAudioFile(forReading: url)
        let duration = Double(file.length) / file.processingFormat.sampleRate
        if duration > 75 {
            return try await transcribeInChunks(file: file, recognizer: recognizer, chunkSeconds: 55)
        }

        let request = SFSpeechURLRecognitionRequest(url: url)
        request.shouldReportPartialResults = false
        if #available(macOS 10.15, *) {
            request.requiresOnDeviceRecognition = onDevice
        }

        return try await recognize(request: request, recognizer: recognizer, timeoutSeconds: 120)
    }

    private func transcribeInChunks(file: AVAudioFile, recognizer: SFSpeechRecognizer, chunkSeconds: Double) async throws -> String {
        let format = file.processingFormat
        let sampleRate = format.sampleRate
        let framesPerChunk = AVAudioFrameCount(chunkSeconds * sampleRate)
        var framePosition: AVAudioFramePosition = 0
        var sections: [String] = []
        var chunkIndex = 1

        while framePosition < file.length {
            file.framePosition = framePosition
            let remaining = AVAudioFrameCount(file.length - framePosition)
            let frameCount = min(framesPerChunk, remaining)
            guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount) else {
                throw RuntimeError("Could not allocate audio buffer.")
            }
            try file.read(into: buffer, frameCount: frameCount)

            if hasSignal(buffer) {
                let request = SFSpeechAudioBufferRecognitionRequest()
                request.shouldReportPartialResults = false
                if #available(macOS 10.15, *) {
                    request.requiresOnDeviceRecognition = onDevice
                }
                request.append(buffer)
                request.endAudio()

                let text = try await recognize(
                    request: request,
                    recognizer: recognizer,
                    timeoutSeconds: max(45, chunkSeconds * 2)
                )
                if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    let start = timestamp(seconds: Double(framePosition) / sampleRate)
                    sections.append("[\(start)] \(text)")
                }
            }

            framePosition += AVAudioFramePosition(frameCount)
            chunkIndex += 1
            if chunkIndex % 10 == 0 {
                fputs("MAC_SPEECH_TRANSCRIBER_PROGRESS: processed \(Int(Double(framePosition) / sampleRate)) seconds\n", stderr)
            }
        }

        return sections.joined(separator: "\n\n")
    }

    private func recognize(request: SFSpeechRecognitionRequest, recognizer: SFSpeechRecognizer, timeoutSeconds: Double) async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            let lock = NSLock()
            var didFinish = false
            var bestText = ""
            var task: SFSpeechRecognitionTask?

            func finish(_ result: Result<String, Error>) {
                lock.lock()
                defer { lock.unlock() }
                if didFinish { return }
                didFinish = true
                switch result {
                case .success:
                    task?.finish()
                case .failure:
                    task?.cancel()
                }
                continuation.resume(with: result)
            }

            task = recognizer.recognitionTask(with: request) { result, error in
                if let result {
                    bestText = result.bestTranscription.formattedString
                    if result.isFinal {
                        finish(.success(bestText))
                        return
                    }
                }

                if let error {
                    finish(.failure(error))
                }
            }

            DispatchQueue.global().asyncAfter(deadline: .now() + timeoutSeconds) {
                finish(.success(bestText))
            }
        }
    }

    private func hasSignal(_ buffer: AVAudioPCMBuffer) -> Bool {
        guard let channels = buffer.floatChannelData else { return true }
        let channelCount = Int(buffer.format.channelCount)
        let frameLength = Int(buffer.frameLength)
        var sum: Double = 0
        for channel in 0..<channelCount {
            for frame in 0..<frameLength {
                let sample = channels[channel][frame]
                sum += Double(sample * sample)
            }
        }
        let samples = max(1, channelCount * frameLength)
        let rms = sqrt(sum / Double(samples))
        return rms > 0.0002
    }

    private func timestamp(seconds: Double) -> String {
        let total = Int(seconds.rounded())
        let hours = total / 3600
        let minutes = (total % 3600) / 60
        let secs = total % 60
        if hours > 0 {
            return String(format: "%d:%02d:%02d", hours, minutes, secs)
        }
        return String(format: "%02d:%02d", minutes, secs)
    }
}

@main
struct Main {
    static func main() async {
        do {
            let args = CommandLine.arguments
            guard args.count >= 2 else {
                throw RuntimeError("Usage: MacSpeechTranscriber <audio-file> [--locale en_US] [--allow-network]")
            }

            let fileURL = URL(fileURLWithPath: args[1])
            let localeIndex = args.firstIndex(of: "--locale")
            let locale = localeIndex.flatMap { index in
                args.indices.contains(index + 1) ? args[index + 1] : nil
            } ?? "en_US"
            let onDevice = !args.contains("--allow-network")

            let outputPath = valueAfter("--output", in: args)

            let transcriber = Transcriber(localeIdentifier: locale, onDevice: onDevice)
            try await transcriber.requestAuthorization()
            let text = try await transcriber.transcribe(url: fileURL)
            if let outputPath {
                try text.write(toFile: outputPath, atomically: true, encoding: .utf8)
            } else {
                print(text)
            }
        } catch {
            let message = "MAC_SPEECH_TRANSCRIBER_FATAL: \(error)"
            if let errorOutputPath = valueAfter("--error-output", in: CommandLine.arguments) {
                try? message.write(toFile: errorOutputPath, atomically: true, encoding: .utf8)
            }
            fputs("\(message)\n", stderr)
            exit(1)
        }
    }

    private static func valueAfter(_ flag: String, in args: [String]) -> String? {
        let index = args.firstIndex(of: flag)
        return index.flatMap { index in
                args.indices.contains(index + 1) ? args[index + 1] : nil
        }
    }
}
