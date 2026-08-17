# Troubleshooting

Start here. Run the health check — it tests all three pieces and tells you which one is unhappy.

```powershell
.\scripts\Test-Horizon.ps1
```

## "Windows protected your PC" when starting

Windows tags files that came from the internet and warns before running them. It is not saying anything is wrong with Horizon.

The cleanest fix is to clone the repository rather than download a ZIP, because cloned files carry no tag:

```powershell
git clone <repository-url>
```

If you already have a ZIP, clear the tag once after extracting:

```powershell
cd path\to\horizon
Get-ChildItem -Recurse | Unblock-File
```

You can also click **More info** then **Run anyway** on the warning itself, but unblocking is tidier because it stops the prompt recurring.

## "Script execution is disabled on this system"

Windows blocks unsigned scripts by default. Allow them for the current window only:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

This lasts until you close the window. Do not make a permanent change unless your organisation permits it.

## "The term 'foundry' is not recognized"

Foundry Local was installed but Windows has not picked up the new command. **Close PowerShell, open a new window**, then check:

```powershell
foundry --version
```

## "'node' was not found"

Install Node.js 18 or later from an approved source, then reopen PowerShell. Verify:

```powershell
node --version
```

## The port keeps changing

That is intentional, and nothing is broken.

Foundry Local chooses its own port each time it starts. The web server, by default, asks Windows for any free port. Both are discovered at run time, so an address you bookmarked yesterday may not work today.

Always use the address printed by `Start-Horizon.ps1`. To keep it constant, set a fixed port in `config.json`:

```json
"web": { "port": 3000 }
```

## "Port N is in use and no free port was found"

Something else is occupying your pinned port. Either let the system choose one for you by setting `"port": 0` in `config.json`, or pick a different one for a single run:

```powershell
.\scripts\Start-Horizon.ps1 -WebPort 3100
```

To see what is holding the port:

```powershell
Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue
```

## "The Foundry Local endpoint could not be discovered"

The Foundry service is not running. Start it and check:

```powershell
foundry server restart
foundry server status
```

## "No loaded model matches the alias ..."

The model was never downloaded, or is not currently loaded. The message lists what *is* loaded. To fix it:

```powershell
foundry model list --cached
foundry model load phi-4
```

If it is not in the cached list, download it first:

```powershell
foundry model download phi-4
```

## The page says "Model not ready"

The web server is fine; Foundry is not cooperating. The message under the input box names the exact problem. Usually:

```powershell
foundry model load phi-4
```

The page rechecks automatically every twenty seconds.

## The page says "Local server unavailable"

The Node.js server has stopped. Look at the PowerShell window that started it — if it has closed or shows an error, run `Start-Horizon.ps1` again.

## A reply times out

Large models can be slow on first use, as weights load into memory. If replies consistently exceed the limit, raise it in `config.json`:

```json
"foundry": { "requestTimeoutMs": 240000 }
```

Or try a smaller model:

```powershell
.\scripts\Start-Horizon.ps1 -ModelAlias qwen2.5-0.5b
```

## "Your message is too large"

You have exceeded the request size limit. Click **Clear chat** to start fresh, or raise `chat.maxRequestBytes` in `config.json`.

## The model forgets earlier parts of the conversation

By design. Only the most recent `chat.historyLimit` messages are sent, to keep replies fast. When older messages are dropped, the note under the input box says so. Raise the limit in `config.json` if you need longer memory — at the cost of speed.

## Replies are slow

First, measure rather than guess:

```powershell
.\scripts\Optimize-Horizon.ps1 -IncludeCandidates -Apply
```

This benchmarks every downloaded model on your actual hardware and switches to the fastest sensible one.

Things worth knowing:

- **Model size dominates.** A 1.5B model is several times faster than a 14B one.
- **Avoid reasoning models for chat.** Models such as `qwen3` and `phi-4-reasoning` think out loud before answering. Measured here: 1067 tokens spent answering "say hello in five words". Their working is folded into a collapsible section, but you still wait for it.
- **Under ~10 tokens/second, replies appear slower than reading pace.** That is your hardware, not a bug. Streaming means you can start reading almost immediately regardless.
- **On ARM machines**, Foundry 0.10.3 publishes no NPU variants, so the NPU cannot help. `Optimize-Horizon.ps1` reports this.

## The first message is slow, later ones are fine

Normal. The first completion after a model loads pays a one-off cost. The app sends a warm-up request at startup to absorb it; if you message before that finishes, you will still feel it. To turn it off:

```json
"foundry": { "warmUpOnStart": false }
```

## Long conversations get slower

Every message re-sends the conversation so far for reprocessing. Click **Clear** to start fresh, or lower `chat.historyLimit` in `config.json`. The app warns you when older messages are being dropped.

## A reply stopped halfway

If the note says *cut off at the length limit*, the model reached its output cap. Ask it to be more concise, or ask for the remainder.

If you pressed stop or `Esc`, that is expected — whatever had been written is kept.

## Opening the Foundry address shows a 404

Expected. Foundry's address is an API, not a web page. The chat page is the address printed by `Start-Horizon.ps1`. To confirm Foundry itself is alive, visit `<foundry-address>/v1/models`.

## The chat page looks unstyled

`app.css` or `app.js` failed to load. Confirm all three files exist in `public/`:

```powershell
Get-ChildItem .\public
```

You should see `index.html`, `app.css`, and `app.js`. Then refresh with `Ctrl+F5`.

## Stop-Horizon says nothing was running

The state file `.runtime/horizon.json` is missing, so the script does not know which process to stop. If a server window is still open, press `Ctrl+C` in it. Then release the model:

```powershell
foundry model unload phi-4
foundry server stop
```

## Checking that it truly works offline

1. Start the app and send a message successfully.
2. Disconnect the network, or apply approved isolation.
3. Run `Stop-Horizon.ps1`, then `Start-Horizon.ps1` again.
4. Send another message. It should still answer.
5. Confirm every address printed uses `127.0.0.1`.

## The microphone button is missing

Dictation is off until you ask for it. Add this to `config.local.json` and restart Horizon:

```json
{ "dictation": { "enabled": true } }
```

If it is switched on and the button still does not appear, the terminal helper it needs is not installed. Run `npm install` in the Horizon folder. Chat is unaffected either way — Horizon says on the page why dictation is unavailable rather than offering a button that cannot work.

## Dictation hears nothing, or hears the wrong microphone

Foundry records through **whatever Windows has set as the default input device**, and Horizon cannot choose for you. The page never opens the microphone itself, so it has no microphone picker: offering a list it could not honour would be a lie.

Set the device you want in **Settings → System → Sound → Input**, then start the recording again. Two things worth checking while you are there: some headsets have an inline mute switch that Windows reports as a working device, and a far-field laptop array will hear you far more faintly than a headset boom.

Your browser's microphone permission has nothing to do with this. Dictation works whether or not the page has been granted access, and works in a private window, because the recording is not happening in the browser.

## "Foundry is still holding a recording session from earlier"

Foundry keeps an audio stream open while recording, and that stream belongs to the Foundry service rather than to Horizon. If a recording ends abruptly — the machine was shut down, the process was killed — the stream can be left held, and the next recording is refused.

Horizon restarts the Foundry service once to clear it, and says so while it happens. The chat model is dropped with it and has to load again, which is why it is only done after a recording has actually failed.

If it happens repeatedly, clear it by hand:

```powershell
foundry server restart
```

Unloading the speech model does **not** release the stream, even though the command reports success.

## Dictation writes into the message box, not the conversation

That is deliberate. Speech is an input method, so it goes where the cursor is: you can read it, correct it, and decide whether to send it. Nothing is sent until you send it.

## Useful commands

```powershell
foundry --version              # is Foundry installed
foundry server status          # is the service running, and where
foundry server restart         # clear a recording session left open
foundry model list             # what models exist
foundry model list --cached    # what is downloaded to this machine
foundry model list --loaded    # what is currently in memory
```
