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

const string AgentVersion = "2.0.0";

Console.Title = "MAGHRABI Remote Agent";
Console.OutputEncoding = Encoding.UTF8;

var configPath = Path.Combine(AppContext.BaseDirectory, "agent.config.json");
if (!File.Exists(configPath))
{
    Console.WriteLine("MAGHRABI Remote Agent");
    Console.WriteLine("لم يتم العثور على agent.config.json بجانب ملف Agent.exe");
    Console.WriteLine("ضع ملف الإعدادات بجانب البرنامج ثم شغّله مرة أخرى.");
    return;
}

AgentConfig? config;
try
{
    var configJson = await File.ReadAllTextAsync(configPath);
    config = JsonSerializer.Deserialize<AgentConfig>(configJson, new JsonSerializerOptions
    {
        PropertyNameCaseInsensitive = true
    });
}
catch (Exception ex)
{
    Console.WriteLine($"تعذر قراءة ملف الإعدادات: {ex.Message}");
    return;
}

if (config is null || string.IsNullOrWhiteSpace(config.ServerUrl) || string.IsNullOrWhiteSpace(config.Token))
{
    Console.WriteLine("ملف agent.config.json غير مكتمل. يجب تحديد serverUrl و token.");
    return;
}

var intervalSeconds = Math.Clamp(config.IntervalSeconds <= 0 ? 15 : config.IntervalSeconds, 5, 300);
var displayName = string.IsNullOrWhiteSpace(config.DisplayName) ? "HOME-PC" : config.DisplayName.Trim();
var baseUrl = config.ServerUrl.TrimEnd('/');
var heartbeatEndpoint = $"{baseUrl}/api/agent/heartbeat";
var sessionStateEndpoint = $"{baseUrl}/api/agent/session-state";
var frameEndpoint = $"{baseUrl}/api/agent/frame";
var deviceId = CreateDeviceId(Environment.MachineName);

using var http = new HttpClient
{
    Timeout = TimeSpan.FromSeconds(15)
};
http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", config.Token.Trim());
http.DefaultRequestHeaders.UserAgent.ParseAdd($"MAGHRABI-Remote-Agent/{AgentVersion}");

using var stop = new CancellationTokenSource();
Console.CancelKeyPress += (_, eventArgs) =>
{
    eventArgs.Cancel = true;
    stop.Cancel();
};

Console.WriteLine("====================================================");
Console.WriteLine("              MAGHRABI REMOTE AGENT V2");
Console.WriteLine("====================================================");
Console.WriteLine($"الجهاز        : {displayName}");
Console.WriteLine($"اسم Windows   : {Environment.MachineName}");
Console.WriteLine($"الخادم        : {config.ServerUrl}");
Console.WriteLine($"Agent Version : {AgentVersion}");
Console.WriteLine($"Screen View   : {(config.ScreenCaptureEnabled ? "Enabled (on authenticated request only)" : "Disabled")}");
Console.WriteLine("الحالة        : بدء الاتصال...");
Console.WriteLine("اضغط Ctrl+C لإيقاف Agent.");
Console.WriteLine();

var heartbeatTask = RunHeartbeatLoopAsync(http, heartbeatEndpoint, deviceId, displayName, intervalSeconds, stop.Token);
var screenTask = config.ScreenCaptureEnabled
    ? RunScreenLoopAsync(http, sessionStateEndpoint, frameEndpoint, stop.Token)
    : Task.CompletedTask;

await Task.WhenAll(heartbeatTask, screenTask);
Console.WriteLine("تم إيقاف MAGHRABI Remote Agent.");

static async Task RunHeartbeatLoopAsync(HttpClient http, string endpoint, string deviceId, string displayName, int intervalSeconds, CancellationToken token)
{
    while (!token.IsCancellationRequested)
    {
        try
        {
            var payload = new HeartbeatPayload(
                deviceId,
                displayName,
                Environment.MachineName,
                RuntimeInformation.OSDescription,
                RuntimeInformation.OSArchitecture.ToString(),
                AgentVersion,
                DateTimeOffset.UtcNow
            );

            using var response = await http.PostAsJsonAsync(endpoint, payload, token);
            var responseText = await response.Content.ReadAsStringAsync(token);

            if (response.IsSuccessStatusCode)
            {
                Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] ONLINE ✓  Heartbeat OK");
            }
            else if ((int)response.StatusCode == 401)
            {
                Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] AUTH ERROR ✗  Token غير صحيح");
            }
            else
            {
                Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] SERVER ERROR {(int)response.StatusCode}  {Trim(responseText, 160)}");
            }
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested)
        {
            break;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] OFFLINE ✗  {ex.Message}");
        }

        try
        {
            await Task.Delay(TimeSpan.FromSeconds(intervalSeconds), token);
        }
        catch (OperationCanceledException)
        {
            break;
        }
    }
}

static async Task RunScreenLoopAsync(HttpClient http, string stateEndpoint, string frameEndpoint, CancellationToken token)
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
                if (wasStreaming) Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] SCREEN ✗  Authentication failed");
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
                        Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] SCREEN ▶  بدأ عرض الشاشة بطلب مصادق عليه");
                        wasStreaming = true;
                    }

                    var jpeg = CapturePrimaryScreenJpeg(55L, 1440);
                    using var content = new ByteArrayContent(jpeg);
                    content.Headers.ContentType = new MediaTypeHeaderValue("image/jpeg");
                    using var upload = await http.PostAsync(frameEndpoint, content, token);
                    if (!upload.IsSuccessStatusCode && (int)upload.StatusCode != 409)
                    {
                        Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] SCREEN ERROR {(int)upload.StatusCode}");
                    }
                }
                else
                {
                    if (wasStreaming)
                    {
                        Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] SCREEN ■  انتهت جلسة العرض");
                        wasStreaming = false;
                    }
                    delayMs = 1200;
                }
            }
            else
            {
                delayMs = 2500;
            }
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested)
        {
            break;
        }
        catch (Exception ex)
        {
            if (wasStreaming) Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] SCREEN OFFLINE ✗  {ex.Message}");
            wasStreaming = false;
            delayMs = 2500;
        }

        try
        {
            await Task.Delay(delayMs, token);
        }
        catch (OperationCanceledException)
        {
            break;
        }
    }
}

static byte[] CapturePrimaryScreenJpeg(long quality, int maxWidth)
{
    var screen = Screen.PrimaryScreen ?? throw new InvalidOperationException("Primary screen not found");
    var bounds = screen.Bounds;

    using var source = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format24bppRgb);
    using (var graphics = Graphics.FromImage(source))
    {
        graphics.CopyFromScreen(bounds.Left, bounds.Top, 0, 0, bounds.Size, CopyPixelOperation.SourceCopy);
    }

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
    finally
    {
        resized?.Dispose();
    }
}

static string CreateDeviceId(string machineName)
{
    var input = Encoding.UTF8.GetBytes($"MAGHRABI-REMOTE::{machineName}");
    return Convert.ToHexString(SHA256.HashData(input))[..24].ToLowerInvariant();
}

static string Trim(string value, int max)
{
    if (string.IsNullOrWhiteSpace(value)) return string.Empty;
    value = value.Replace("\r", " ").Replace("\n", " ").Trim();
    return value.Length <= max ? value : value[..max] + "…";
}

internal sealed class AgentConfig
{
    public string ServerUrl { get; set; } = "https://maghrabi-remote-production.up.railway.app";
    public string Token { get; set; } = string.Empty;
    public string DisplayName { get; set; } = "HOME-PC";
    public int IntervalSeconds { get; set; } = 15;
    public bool ScreenCaptureEnabled { get; set; } = true;
}

internal sealed record HeartbeatPayload(
    string DeviceId,
    string DisplayName,
    string Hostname,
    string Os,
    string Architecture,
    string AgentVersion,
    DateTimeOffset Timestamp
);

internal sealed class SessionState
{
    public bool ScreenRequested { get; set; }
    public int CaptureIntervalMs { get; set; } = 1200;
}
