using System;
using System.Diagnostics;
using System.IO;
using System.ServiceProcess;

sealed class GatewayService : ServiceBase {
    Process child;
    volatile bool stopping;
    readonly object logLock = new object();
    string root = AppDomain.CurrentDomain.BaseDirectory;
    GatewayService() { ServiceName = "KerioAccountSwitcher"; CanStop = true; AutoLog = false; }
    void Log(string line) {
        if (String.IsNullOrEmpty(line)) return;
        lock(logLock) {
            try {
                string path = Path.Combine(root, "logs", "gateway.log");
                if (File.Exists(path) && new FileInfo(path).Length > 5242880) {
                    string previous = path + ".1";
                    if(File.Exists(previous)) File.Delete(previous);
                    File.Move(path, previous);
                }
                File.AppendAllText(path, DateTime.UtcNow.ToString("o") + " " + line + Environment.NewLine);
            } catch { }
        }
    }
    protected override void OnStart(string[] args) {
        stopping = false;
        child = new Process();
        child.StartInfo = new ProcessStartInfo {
            FileName = Path.Combine(root,"runtime","node.exe"),
            Arguments = "\""+Path.Combine(root,"server.mjs")+"\" \""+Path.Combine(root,"config.json")+"\"",
            WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true
        };
        child.OutputDataReceived += (s,e) => Log(e.Data);
        child.ErrorDataReceived += (s,e) => Log(e.Data);
        child.EnableRaisingEvents = true;
        child.Exited += (s,e) => { if(!stopping) { Log("Gateway process exited; requesting service recovery"); Environment.Exit(1); } };
        child.Start(); child.BeginOutputReadLine(); child.BeginErrorReadLine();
    }
    protected override void OnStop() {
        stopping = true;
        if(child != null) { try { if(!child.HasExited) { child.Kill(); child.WaitForExit(10000); } } catch { } child.Dispose(); }
    }
    static void Main() { ServiceBase.Run(new GatewayService()); }
}
