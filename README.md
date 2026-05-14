# Farcelis Meeting Monitor

Local-first meeting recording, post-call transcription, speaker-track separation, prep, and follow-up brief workspace.

## What It Does

- Starts an independent meeting session outside Zoom, Teams, or Google Meet.
- Records native macOS system audio through ScreenCaptureKit so the other speaker is captured without a Zoom/Teams bot.
- Optionally records a separate local microphone track through ScreenCaptureKit on supported macOS versions.
- Uses browser microphone recording as a backup audio source.
- Saves recordings and chunks locally under `data/meetings`.
- Supports OpenAI transcription when quota is available.
- Supports quota-free local transcription through Apple's Speech framework.
- Uses separate system and microphone tracks as practical speaker separation.
- Generates a local meeting brief scaffold even without API quota.
- Creates client folders under `data/clients`.
- Pulls prep notes from client folders and `data/inbox`.
- Matches real macOS Calendar events when access is granted.
- Also matches calendar exports from `.ics` files dropped into `data/inbox`.

## Run It

```bash
cd /Users/nathanespey/Desktop/codex-master-workspace/03_shared-tools/meeting-monitor
cp .env.example .env
```

Default quota-free local mode:

```text
TRANSCRIPTION_PROVIDER=local
LOCAL_TRANSCRIBE_PROVIDER=macos-speech
LOCAL_TRANSCRIBE_LOCALE=en_US
```

OpenAI mode is optional. Set `TRANSCRIPTION_PROVIDER=openai` and add `OPENAI_API_KEY` when quota is available.

Start:

```bash
npm start
```

Open:

```text
http://localhost:8787
```

## Audio Capture

The app is intentionally not onboarded into Zoom, Teams, or calendar systems. The primary recorder is a native macOS helper built on Apple ScreenCaptureKit.

When you press Start:

- The server starts `native/SystemAudioRecorder`.
- macOS captures system audio from the meeting app.
- macOS also records a separate microphone track where supported.
- The browser microphone recorder runs as a backup audio source.

The first native capture may trigger macOS Screen Recording permission. If prompted, grant permission and restart the server.

If native capture ever fails, the UI shows an explicit error. Do not rely on the browser-only fallback for real meetings where the other speaker matters.

## Rebuild Native Recorder

```bash
swiftc -parse-as-library \
  -framework ScreenCaptureKit \
  -framework AVFoundation \
  -framework CoreMedia \
  -o native/SystemAudioRecorder \
  native/SystemAudioRecorder.swift
```

## Rebuild Local Speech Transcriber

```bash
mkdir -p native/MacSpeechTranscriber.app/Contents/MacOS
swiftc -parse-as-library \
  -framework Speech \
  -framework Foundation \
  -o native/MacSpeechTranscriber.app/Contents/MacOS/MacSpeechTranscriber \
  native/MacSpeechTranscriber.swift
cp native/MacSpeechTranscriber-Info.plist native/MacSpeechTranscriber.app/Contents/Info.plist
xattr -cr native/MacSpeechTranscriber.app
codesign --force --deep --sign - native/MacSpeechTranscriber.app
```

The app bundle Info.plist is required by macOS privacy controls. The first local transcription may trigger macOS Speech Recognition permission. Grant permission and retry Finalize.

## Local Whisper Transcription

For long meetings, use `LOCAL_TRANSCRIBE_PROVIDER=whisper.cpp`. The local setup lives in `vendor/whisper.cpp` with the model at `vendor/whisper.cpp/models/ggml-base.en.bin`. Finalize converts each native audio track to 16 kHz mono WAV and runs `whisper-cli` locally, without OpenAI API quota.

## Rebuild Calendar Reader

```bash
swiftc -parse-as-library \
  -framework EventKit \
  -framework Foundation \
  -o native/CalendarReader \
  native/CalendarReader.swift
```

## Consent Script

Use a clean disclosure:

> Just so you know, I’m using a local transcription tool to keep accurate notes from the call. Is that okay?

Only start recording after consent.

## Prep Mode

Prep mode searches:

- `data/clients/<client-name>/notes`
- `data/inbox`

Useful files:

- `.md`
- `.txt`
- `.json`
- `.csv`
- `.ics`

Drop call scripts, CRM exports, proposal notes, or prior meeting notes into the client folder before a call.

## Calendar Matching

Calendar Match reads from macOS Calendar using EventKit. If Google, Outlook, iCloud, or other accounts are synced into the Mac Calendar app, Meeting Monitor can match those events locally after permission is granted.

The first calendar read may trigger macOS Calendar permission. Grant access and retry Calendar Match.

As a fallback, export calendar events as `.ics` and place them in:

```text
data/inbox
```

Calendar Match looks for events near the current time and scores them against the meeting title, client, and attendees.

## Output Files

Each meeting gets a folder:

```text
data/meetings/YYYY-MM-DD-client-title-id/
```

Inside:

- `meeting.json`
- `recording.webm`
- `native/system-audio.m4a`
- `native/microphone-audio.m4a`
- `recording-events.md`
- `transcript.md`
- `diarized.json`
- `brief.md`
- `chunks/*.webm`

## Current Limits

- Local transcription is final-file transcription, not true live streaming.
- Local speaker separation is track-based: microphone track is Nathan/local audio, system track is the other side of the call.
- If multiple remote speakers talk on the same meeting audio track, local mode does not separate those remote speakers yet.
- OpenAI diarization remains available only in `TRANSCRIPTION_PROVIDER=openai` mode.
- Calendar matching depends on calendars synced into the macOS Calendar app, plus optional `.ics` files in `data/inbox`.

## Good Next Upgrades

- Add known-speaker reference clips for Nathan/client mapping.
- Add client CRM profile files with structured fields.
- Add automatic follow-up draft saving per client.
- Add a dedicated Realtime API WebSocket path for lower-latency transcription.
