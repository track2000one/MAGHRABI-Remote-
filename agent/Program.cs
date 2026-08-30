using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

const string AgentVersion = "1.0.0";

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
var endpoint = $"{config.ServerUrl.TrimEnd('/')}/api/agent/heartbeat";
var deviceId = CreateDeviceId(Environment.MachineName);

using var http = new HttpClient
{
    Timeout = TimeSpan.FromSeconds(12)
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
Console.WriteLine("              MAGHRABI REMOTE AGENT");
Console.WriteLine("====================================================");
Console.WriteLine($"الجهاز        : {displayName}");
Console.WriteLine($"اسم Windows   : {Environment.MachineName}");
Console.WriteLine($"الخادم        : {config.ServerUrl}");
Console.WriteLine($"Agent Version : {AgentVersion}");
Console.WriteLine("الحالة        : بدء الاتصال...");
Console.WriteLine("اضغط Ctrl+C لإيقاف Agent.");
Console.WriteLine();

while (!stop.IsCancellationRequested)
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

        using var response = await http.PostAsJsonAsync(endpoint, payload, stop.Token);
        var responseText = await response.Content.ReadAsStringAsync(stop.Token);

        if (response.IsSuccessStatusCode)
        {
            Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] ONLINE ✓  تم إرسال Heartbeat بنجاح");
        }
        else if ((int)response.StatusCode == 401)
        {
            Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] AUTH ERROR ✗  Token غير صحيح. تحقق من Railway و agent.config.json");
        }
        else
        {
            Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] SERVER ERROR {(int)response.StatusCode}  {Trim(responseText, 160)}");
        }
    }
    catch (OperationCanceledException) when (stop.IsCancellationRequested)
    {
        break;
    }
    catch (Exception ex)
    {
        Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] OFFLINE ✗  {ex.Message}");
    }

    try
    {
        await Task.Delay(TimeSpan.FromSeconds(intervalSeconds), stop.Token);
    }
    catch (OperationCanceledException)
    {
        break;
    }
}

Console.WriteLine("تم إيقاف MAGHRABI Remote Agent.");

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
