using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Windows.Forms;

namespace MaghrabiRemoteAgent;

internal static class Program
{
    private const string AgentVersion = "2.2.0";
    private static readonly string BaseDir = AppContext.BaseDirectory;
    private static readonly string LogPath = Path.Combine(BaseDir, "agent.log");

    private const uint MouseLeftDown = 0x0002;
    private const uint MouseLeftUp = 0x0004;
    private const uint MouseRightDown = 0x0008;
    private const uint MouseRightUp = 0x0010;
    private const uint MouseMiddleDown = 0x0020;
    private const uint MouseMiddleUp = 0x0040;
    private const uint MouseWheel = 0x0800;
    private const uint KeyUp = 0x0002;
    private const uint KeyExtended = 0x0001;

    [STAThread]
    private static async Task<int> Main()
    {
        Console.Title = "MAGHRABI Remote Agent";
        Console.OutputEncoding = Encoding.UTF8;

        AppDomain.CurrentDomain.UnhandledException += (_, e) =>
        {
            WriteLog("UNHANDLED", e.ExceptionObject?.ToString() ?? "Unknown exception");
        };
        TaskScheduler.UnobservedTaskException += (_, e) =>
        {
            WriteLog("TASK-ERROR", e.Exception.ToString());
            e.SetObserved();
        };

        try
        {
            return await RunAsync();
        }
        catch (Exception ex)
        {
            WriteLog("FATAL", ex.ToString());
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine();
            Console.WriteLine("حدث خطأ غير متوقع في MAGHRABI Remote Agent:");
            Console.WriteLine(ex.Message);
            Console.ResetColor();
            Console.WriteLine();
            Console.WriteLine($"تم حفظ التفاصيل في: {LogPath}");
            Pause();
            return 1;
        }
    }

    private static async Task<int> RunAsync()
    {
        Header();
        WriteLog("START", $"Agent {AgentVersion} started on {Environment.MachineName}");

        var configPath = Path.Combine(BaseDir, "agent.config.json");
        if (!File.Exists(configPath))
        {
            var template = new AgentConfig
            {
                ServerUrl = "https://maghrabi-remote-production.up.railway.app",
                Token = "PUT_YOUR_RAILWAY_AGENT_TOKEN_HERE",
                DisplayName = "HOME-PC",
                IntervalSeconds = 15,
                ScreenCaptureEnabled = true,
                RemoteControlEnabled = true
            };
            await File.WriteAllTextAsync(configPath, JsonSerializer.Serialize(template, new JsonSerializerOptions { WriteIndented = true }));
            Console.WriteLine("لم يتم العثور على agent.config.json.");
            Console.WriteLine("تم إنشاء ملف جديد تلقائيًا بجانب البرنامج.");
            Console.WriteLine("افتح agent.config.json وضع MAGHRABI_AGENT_TOKEN في حقل token ثم شغّل البرنامج مجددًا.");
            WriteLog("CONFIG", "agent.config.json was missing; template created.");
            Pause();
            return 2;
        }

        AgentConfig? config;
        try
        {
            var json = await File.ReadAllTextAsync(configPath);
            config = JsonSerializer.Deserialize<AgentConfig>(json, new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
        }
        catch (Exception ex)
        {
            Console.WriteLine("تعذر قراءة agent.config.json:");
            Console.WriteLine(ex.Message);
            WriteLog("CONFIG-ERROR", ex.ToString());
            Pause();
            return 3;
        }

        if (config is null || string.IsNullOrWhiteSpace(config.ServerUrl) || string.IsNullOrWhiteSpace(config.Token))
        {
            Console.WriteLine("ملف agent.config.json غير مكتمل. يجب تحديد serverUrl و token.");
            WriteLog("CONFIG-ERROR", "Missing serverUrl or token.");
            Pause();
            return 4;
        }

        if (config.Token.Contains("PUT_YOUR", StringComparison.OrdinalIgnoreCase))
        {
            Console.WriteLine("حقل token ما زال بالقيمة التجريبية.");
            Console.WriteLine("ضع قيمة MAGHRABI_AGENT_TOKEN الموجودة في Railway ثم شغّل Agent من جديد.");
            WriteLog("CONFIG-ERROR", "Placeholder token detected.");
            Pause();
            return 5;
        }

        var intervalSeconds = Math.Clamp(config.IntervalSeconds <= 0 ? 15 : config.IntervalSeconds, 5, 300);
        var displayName = string.IsNullOrWhiteSpace(config.DisplayName) ? "HOME-PC" : config.DisplayName.Trim();
        var baseUrl = config.ServerUrl.TrimEnd('/');
        var heartbeatEndpoint = $"{baseUrl}/api/agent/heartbeat";
        var sessionStateEndpoint = $"{baseUrl}/api/agent/session-state";
        var frameEndpoint = $"{baseUrl}/api/agent/frame";
        var commandsEndpoint = $"{baseUrl}/api/agent/commands";
        var deviceId = CreateDeviceId(Environment.MachineName);

        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
        http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", config.Token.Trim());
        http.DefaultRequestHeaders.UserAgent.ParseAdd($"MAGHRABI-Remote-Agent/{AgentVersion}");

        using var stop = new CancellationTokenSource();
        Console.CancelKeyPress += (_, e) => { e.Cancel = true; stop.Cancel(); };

        Console.WriteLine($"الجهاز        : {displayName}");
        Console.WriteLine($"اسم Windows   : {Environment.MachineName}");
        Console.WriteLine($"الخادم        : {config.ServerUrl}");
        Console.WriteLine($"Agent Version : {AgentVersion}");
        Console.WriteLine($"Screen View   : {(config.ScreenCaptureEnabled ? "Enabled" : "Disabled")}");
        Console.WriteLine($"Remote Input  : {(config.RemoteControlEnabled ? "Enabled" : "Disabled")}");
        Console.WriteLine($"Log           : {LogPath}");
        Console.WriteLine("الحالة        : بدء الاتصال...");
        Console.WriteLine("اضغط Ctrl+C لإيقاف Agent.");
        Console.WriteLine();

        var heartbeatTask = RunHeartbeatLoopAsync(http, heartbeatEndpoint, deviceId, displayName, intervalSeconds, stop.Token);
        var screenTask = config.ScreenCaptureEnabled
            ? RunScreenLoopAsync(http, sessionStateEndpoint, frameEndpoint, stop.Token)
            : Task.CompletedTask;
        var controlTask = config.RemoteControlEnabled
            ? RunControlLoopAsync(http, commandsEndpoint, stop.Token)
            : Task.CompletedTask;

        await Task.WhenAll(heartbeatTask, screenTask, controlTask);
        WriteLog("STOP", "Agent stopped normally.");
        return 0;
    }

    private static void Header()
    {
        Console.WriteLine("====================================================");
        Console.WriteLine("           MAGHRABI REMOTE AGENT V2.2");
        Console.WriteLine("====================================================");
    }

    private static void Pause()
    {
        Console.WriteLine();
        Console.WriteLine("اضغط Enter لإغلاق النافذة...");
        Console.ReadLine();
    }

    private static void WriteLog(string type, string message)
    {
        try
        {
            File.AppendAllText(LogPath, $"[{DateTimeOffset.Now:yyyy-MM-dd HH:mm:ss zzz}] [{type}] {message}{Environment.NewLine}", Encoding.UTF8);
        }
        catch { }
    }

    private static async Task RunHeartbeatLoopAsync(HttpClient http, string endpoint, string deviceId, string displayName, int intervalSeconds, CancellationToken token)
    {
        while (!token.IsCancellationRequested)
        {
            try
            {
                var payload = new HeartbeatPayload(deviceId, displayName, Environment.MachineName,
                    RuntimeInformation.OSDescription, RuntimeInformation.OSArchitecture.ToString(), AgentVersion, DateTimeOffset.UtcNow);
                using var response = await http.PostAsJsonAsync(endpoint, payload, token);
                var text = await response.Content.ReadAsStringAsync(token);

                if (response.IsSuccessStatusCode)
                {
                    Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] ONLINE ✓  Heartbeat OK");
                }
                else if ((int)response.StatusCode == 401)
                {
                    Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] AUTH ERROR ✗  Token غير صحيح");
                    WriteLog("AUTH", "Railway returned 401 Unauthorized.");
                }
                else
                {
                    Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] SERVER ERROR {(int)response.StatusCode}  {Trim(text, 160)}");
                    WriteLog("SERVER", $"Heartbeat HTTP {(int)response.StatusCode}: {Trim(text, 500)}");
                }
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { break; }
            catch (Exception ex)
            {
                Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] OFFLINE ✗  {ex.Message}");
                WriteLog("HEARTBEAT", ex.ToString());
            }

            try { await Task.Delay(TimeSpan.FromSeconds(intervalSeconds), token); }
            catch (OperationCanceledException) { break; }
        }
    }

    private static async Task RunScreenLoopAsync(HttpClient http, string stateEndpoint, string frameEndpoint, CancellationToken token)
    {
        var wasStreaming = false;
        while (!token.IsCancellationRequested)
        {
            var delayMs = 1200;
            try
            {
                using var stateResponse = await http.GetAsync(stateEndpoint, token);
                if ((int)stateResponse.StatusCode == 401)
                {
                    wasStreaming = false;
                    delayMs = 3000;
                }
                else if (stateResponse.IsSuccessStatusCode)
                {
                    var state = await stateResponse.Content.ReadFromJsonAsync<SessionState>(cancellationToken: token);
                    var requested = state?.ScreenRequested == true;
                    delayMs = Math.Clamp(state?.CaptureIntervalMs ?? 1200, 700, 5000);

                    if (requested)
                    {
                        if (!wasStreaming)
                        {
                            Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] SCREEN ▶  بدأ عرض الشاشة");
                            WriteLog("SCREEN", "Authenticated screen session started.");
                            wasStreaming = true;
                        }

                        var jpeg = CapturePrimaryScreenJpeg(55L, 1440);
                        using var content = new ByteArrayContent(jpeg);
                        content.Headers.ContentType = new MediaTypeHeaderValue("image/jpeg");
                        using var upload = await http.PostAsync(frameEndpoint, content, token);
                        if (!upload.IsSuccessStatusCode && (int)upload.StatusCode != 409)
                            WriteLog("SCREEN", $"Frame upload HTTP {(int)upload.StatusCode}");
                    }
                    else
                    {
                        if (wasStreaming)
                        {
                            Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] SCREEN ■  انتهت جلسة العرض");
                            WriteLog("SCREEN", "Screen session ended.");
                            wasStreaming = false;
                        }
                        delayMs = 1200;
                    }
                }
                else delayMs = 2500;
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { break; }
            catch (Exception ex)
            {
                if (wasStreaming) Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] SCREEN OFFLINE ✗  {ex.Message}");
                WriteLog("SCREEN-ERROR", ex.ToString());
                wasStreaming = false;
                delayMs = 2500;
            }

            try { await Task.Delay(delayMs, token); }
            catch (OperationCanceledException) { break; }
        }
    }

    private static async Task RunControlLoopAsync(HttpClient http, string commandsEndpoint, CancellationToken token)
    {
        long lastSeq = 0;
        var wasActive = false;
        var heldKeys = new Dictionary<byte, uint>();
        var heldButtons = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        try
        {
            while (!token.IsCancellationRequested)
            {
                var delayMs = wasActive ? 80 : 1000;
                try
                {
                    using var response = await http.GetAsync($"{commandsEndpoint}?after={lastSeq}", token);
                    if ((int)response.StatusCode == 401)
                    {
                        if (wasActive) ReleaseAllInputs(heldKeys, heldButtons);
                        wasActive = false;
                        delayMs = 3000;
                    }
                    else if (response.IsSuccessStatusCode)
                    {
                        var batch = await response.Content.ReadFromJsonAsync<CommandBatch>(cancellationToken: token);
                        if (batch is null)
                        {
                            delayMs = 1000;
                        }
                        else
                        {
                            if (batch.LatestSeq < lastSeq) lastSeq = 0;
                            var active = batch.Active && batch.ControlRequested;
                            if (active)
                            {
                                if (!wasActive)
                                {
                                    Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] CONTROL ▶  بدأ التحكم بالماوس والكيبورد");
                                    WriteLog("CONTROL", "Authenticated remote input session started.");
                                }
                                wasActive = true;
                                delayMs = 80;

                                foreach (var command in batch.Commands.OrderBy(item => item.Seq))
                                {
                                    if (command.Seq <= lastSeq) continue;
                                    try
                                    {
                                        ApplyRemoteCommand(command, heldKeys, heldButtons);
                                    }
                                    catch (Exception ex)
                                    {
                                        WriteLog("CONTROL-COMMAND", $"Seq {command.Seq}: {ex}");
                                    }
                                    lastSeq = command.Seq;
                                }
                            }
                            else
                            {
                                if (wasActive)
                                {
                                    ReleaseAllInputs(heldKeys, heldButtons);
                                    Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] CONTROL ■  انتهت جلسة التحكم");
                                    WriteLog("CONTROL", "Remote input session ended.");
                                }
                                wasActive = false;
                                lastSeq = Math.Max(lastSeq, batch.LatestSeq);
                                delayMs = 1000;
                            }
                        }
                    }
                    else
                    {
                        delayMs = 1500;
                    }
                }
                catch (OperationCanceledException) when (token.IsCancellationRequested) { break; }
                catch (Exception ex)
                {
                    if (wasActive)
                    {
                        ReleaseAllInputs(heldKeys, heldButtons);
                        Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] CONTROL OFFLINE ✗  {ex.Message}");
                    }
                    WriteLog("CONTROL-ERROR", ex.ToString());
                    wasActive = false;
                    delayMs = 1500;
                }

                try { await Task.Delay(delayMs, token); }
                catch (OperationCanceledException) { break; }
            }
        }
        finally
        {
            ReleaseAllInputs(heldKeys, heldButtons);
        }
    }

    private static void ApplyRemoteCommand(RemoteCommand command, Dictionary<byte, uint> heldKeys, HashSet<string> heldButtons)
    {
        switch (command.Type)
        {
            case "move":
                if (command.X is not null && command.Y is not null)
                    MoveCursorNormalized(command.X.Value, command.Y.Value);
                break;

            case "button":
                ApplyMouseButton(command.Button, command.Action, heldButtons);
                break;

            case "wheel":
                if (command.Delta is not null)
                {
                    var delta = Math.Clamp(command.Delta.Value, -1200, 1200);
                    mouse_event(MouseWheel, 0, 0, unchecked((uint)delta), UIntPtr.Zero);
                }
                break;

            case "key":
                ApplyKeyboard(command.Code, command.Action, heldKeys);
                break;

            case "release":
                ReleaseAllInputs(heldKeys, heldButtons);
                break;
        }
    }

    private static void MoveCursorNormalized(double x, double y)
    {
        var screen = Screen.PrimaryScreen ?? throw new InvalidOperationException("Primary screen not found");
        var bounds = screen.Bounds;
        x = Math.Clamp(x, 0d, 1d);
        y = Math.Clamp(y, 0d, 1d);
        var px = bounds.Left + (int)Math.Round(x * Math.Max(0, bounds.Width - 1));
        var py = bounds.Top + (int)Math.Round(y * Math.Max(0, bounds.Height - 1));
        SetCursorPos(px, py);
    }

    private static void ApplyMouseButton(string? button, string? action, HashSet<string> heldButtons)
    {
        if (string.IsNullOrWhiteSpace(button) || string.IsNullOrWhiteSpace(action)) return;
        var down = action.Equals("down", StringComparison.OrdinalIgnoreCase);
        uint flag = (button.ToLowerInvariant(), down) switch
        {
            ("left", true) => MouseLeftDown,
            ("left", false) => MouseLeftUp,
            ("right", true) => MouseRightDown,
            ("right", false) => MouseRightUp,
            ("middle", true) => MouseMiddleDown,
            ("middle", false) => MouseMiddleUp,
            _ => 0
        };
        if (flag == 0) return;
        mouse_event(flag, 0, 0, 0, UIntPtr.Zero);
        if (down) heldButtons.Add(button); else heldButtons.Remove(button);
    }

    private static void ApplyKeyboard(string? code, string? action, Dictionary<byte, uint> heldKeys)
    {
        if (string.IsNullOrWhiteSpace(code) || string.IsNullOrWhiteSpace(action)) return;
        var virtualKey = VirtualKeyFromCode(code);
        if (virtualKey is null) return;

        var extended = IsExtendedKey(code) ? KeyExtended : 0u;
        if (action.Equals("down", StringComparison.OrdinalIgnoreCase))
        {
            keybd_event(virtualKey.Value, 0, extended, UIntPtr.Zero);
            heldKeys[virtualKey.Value] = extended;
        }
        else if (action.Equals("up", StringComparison.OrdinalIgnoreCase))
        {
            keybd_event(virtualKey.Value, 0, extended | KeyUp, UIntPtr.Zero);
            heldKeys.Remove(virtualKey.Value);
        }
    }

    private static void ReleaseAllInputs(Dictionary<byte, uint> heldKeys, HashSet<string> heldButtons)
    {
        foreach (var item in heldKeys.ToArray())
        {
            keybd_event(item.Key, 0, item.Value | KeyUp, UIntPtr.Zero);
        }
        heldKeys.Clear();

        if (heldButtons.Contains("left")) mouse_event(MouseLeftUp, 0, 0, 0, UIntPtr.Zero);
        if (heldButtons.Contains("right")) mouse_event(MouseRightUp, 0, 0, 0, UIntPtr.Zero);
        if (heldButtons.Contains("middle")) mouse_event(MouseMiddleUp, 0, 0, 0, UIntPtr.Zero);
        heldButtons.Clear();
    }

    private static byte? VirtualKeyFromCode(string code)
    {
        if (code.Length == 4 && code.StartsWith("Key", StringComparison.Ordinal) && char.IsLetter(code[3]))
            return (byte)char.ToUpperInvariant(code[3]);
        if (code.Length == 6 && code.StartsWith("Digit", StringComparison.Ordinal) && char.IsDigit(code[5]))
            return (byte)code[5];
        if (code.Length == 7 && code.StartsWith("Numpad", StringComparison.Ordinal) && char.IsDigit(code[6]))
            return (byte)(0x60 + (code[6] - '0'));
        if (code.StartsWith("F", StringComparison.Ordinal) && int.TryParse(code[1..], out var function) && function is >= 1 and <= 24)
            return (byte)(0x70 + function - 1);

        return code switch
        {
            "Backspace" => 0x08,
            "Tab" => 0x09,
            "Enter" => 0x0D,
            "ShiftLeft" or "ShiftRight" => 0x10,
            "ControlLeft" or "ControlRight" => 0x11,
            "AltLeft" or "AltRight" => 0x12,
            "Pause" => 0x13,
            "CapsLock" => 0x14,
            "Escape" => 0x1B,
            "Space" => 0x20,
            "PageUp" => 0x21,
            "PageDown" => 0x22,
            "End" => 0x23,
            "Home" => 0x24,
            "ArrowLeft" => 0x25,
            "ArrowUp" => 0x26,
            "ArrowRight" => 0x27,
            "ArrowDown" => 0x28,
            "PrintScreen" => 0x2C,
            "Insert" => 0x2D,
            "Delete" => 0x2E,
            "MetaLeft" => 0x5B,
            "MetaRight" => 0x5C,
            "ContextMenu" => 0x5D,
            "NumpadMultiply" => 0x6A,
            "NumpadAdd" => 0x6B,
            "NumpadSubtract" => 0x6D,
            "NumpadDecimal" => 0x6E,
            "NumpadDivide" => 0x6F,
            "NumLock" => 0x90,
            "ScrollLock" => 0x91,
            "Semicolon" => 0xBA,
            "Equal" => 0xBB,
            "Comma" => 0xBC,
            "Minus" => 0xBD,
            "Period" => 0xBE,
            "Slash" => 0xBF,
            "Backquote" => 0xC0,
            "BracketLeft" => 0xDB,
            "Backslash" => 0xDC,
            "BracketRight" => 0xDD,
            "Quote" => 0xDE,
            "IntlBackslash" => 0xE2,
            _ => null
        };
    }

    private static bool IsExtendedKey(string code) => code is
        "ControlRight" or "AltRight" or "MetaLeft" or "MetaRight" or "ContextMenu" or
        "Insert" or "Delete" or "Home" or "End" or "PageUp" or "PageDown" or
        "ArrowLeft" or "ArrowUp" or "ArrowRight" or "ArrowDown" or
        "NumpadDivide" or "PrintScreen";

    private static byte[] CapturePrimaryScreenJpeg(long quality, int maxWidth)
    {
        var screen = Screen.PrimaryScreen ?? throw new InvalidOperationException("Primary screen not found");
        var bounds = screen.Bounds;
        using var source = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format24bppRgb);
        using (var graphics = Graphics.FromImage(source))
            graphics.CopyFromScreen(bounds.Left, bounds.Top, 0, 0, bounds.Size, CopyPixelOperation.SourceCopy);

        Bitmap? resized = null;
        Image output = source;
        if (source.Width > maxWidth)
        {
            var height = (int)Math.Round(source.Height * (maxWidth / (double)source.Width));
            resized = new Bitmap(maxWidth, height, PixelFormat.Format24bppRgb);
            using var graphics = Graphics.FromImage(resized);
            graphics.InterpolationMode = InterpolationMode.HighQualityBilinear;
            graphics.CompositingQuality = CompositingQuality.HighSpeed;
            graphics.SmoothingMode = SmoothingMode.HighSpeed;
            graphics.DrawImage(source, 0, 0, maxWidth, height);
            output = resized;
        }

        try
        {
            using var stream = new MemoryStream();
            var codec = ImageCodecInfo.GetImageEncoders().First(x => x.FormatID == ImageFormat.Jpeg.Guid);
            using var parameters = new EncoderParameters(1);
            parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, Math.Clamp(quality, 20L, 90L));
            output.Save(stream, codec, parameters);
            return stream.ToArray();
        }
        finally { resized?.Dispose(); }
    }

    private static string CreateDeviceId(string machineName)
    {
        var input = Encoding.UTF8.GetBytes($"MAGHRABI-REMOTE::{machineName}");
        return Convert.ToHexString(SHA256.HashData(input))[..24].ToLowerInvariant();
    }

    private static string Trim(string value, int max)
    {
        if (string.IsNullOrWhiteSpace(value)) return string.Empty;
        value = value.Replace("\r", " ").Replace("\n", " ").Trim();
        return value.Length <= max ? value : value[..max] + "…";
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    private static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);

    [DllImport("user32.dll")]
    private static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    internal sealed class AgentConfig
    {
        public string ServerUrl { get; set; } = "https://maghrabi-remote-production.up.railway.app";
        public string Token { get; set; } = string.Empty;
        public string DisplayName { get; set; } = "HOME-PC";
        public int IntervalSeconds { get; set; } = 15;
        public bool ScreenCaptureEnabled { get; set; } = true;
        public bool RemoteControlEnabled { get; set; } = true;
    }

    internal sealed record HeartbeatPayload(string DeviceId, string DisplayName, string Hostname, string Os,
        string Architecture, string AgentVersion, DateTimeOffset Timestamp);

    internal sealed class SessionState
    {
        public bool ScreenRequested { get; set; }
        public bool ControlRequested { get; set; }
        public int CaptureIntervalMs { get; set; } = 1200;
    }

    internal sealed class CommandBatch
    {
        public bool Active { get; set; }
        public bool ControlRequested { get; set; }
        public long LatestSeq { get; set; }
        public List<RemoteCommand> Commands { get; set; } = new();
    }

    internal sealed class RemoteCommand
    {
        public long Seq { get; set; }
        public string Type { get; set; } = string.Empty;
        public double? X { get; set; }
        public double? Y { get; set; }
        public string? Button { get; set; }
        public string? Action { get; set; }
        public int? Delta { get; set; }
        public string? Code { get; set; }
    }
}
