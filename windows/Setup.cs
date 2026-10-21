using System;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Diagnostics;
using System.Reflection;
using System.Threading.Tasks;
using System.Windows.Forms;

sealed class SetupForm : Form {
    TextBox host = new TextBox(), kerio = new TextBox(), target = new TextBox(), log = new TextBox();
    NumericUpDown port = new NumericUpDown();
    Button install = new Button(), uninstall = new Button();
    bool busy;
    public SetupForm() {
        Text="Kerio Account Switcher — установка 1.0.2"; ClientSize=new Size(750,610);
        Font=new Font("Segoe UI",10); StartPosition=FormStartPosition.CenterScreen;
        MinimumSize=Size; MaximizeBox=false;
        var intro=new Label {Left=20,Top=16,Width=710,Height=68,Text="Устанавливайте на сервер Kerio Connect (Windows x64).\nПереключение аккаунтов появится у всех в браузере.\nПри установке и удалении Kerio ненадолго перезапускается."};Controls.Add(intro);
        AddField("Адрес почты (без https://)",host,100);host.Text="mail.example.com";
        AddField("Каталог Kerio MailServer",kerio,143);kerio.Text=@"C:\Program Files\Kerio\MailServer";
        AddField("Каталог установки модуля",target,186);target.Text=@"C:\Program Files\Kerio Account Switcher";
        Controls.Add(new Label{Left=20,Top=232,Width=250,Text="Внутренний HTTPS-порт Kerio"});
        port.SetBounds(285,229,120,28);port.Minimum=1024;port.Maximum=65535;port.Value=8843;Controls.Add(port);
        install.Text="Установить / обновить";install.SetBounds(285,275,170,36);install.Click+=async(s,e)=>await Run(false);Controls.Add(install);
        uninstall.Text="Удалить и вернуть Kerio";uninstall.SetBounds(465,275,260,36);uninstall.Click+=async(s,e)=>await Run(true);Controls.Add(uninstall);
        log.SetBounds(20,328,705,260);log.Multiline=true;log.ReadOnly=true;log.ScrollBars=ScrollBars.Vertical;log.Font=new Font("Consolas",9);Controls.Add(log);
        FormClosing+=(s,e)=>{if(busy)e.Cancel=true;};
    }
    void AddField(string label,TextBox box,int y){Controls.Add(new Label{Left=20,Top=y+3,Width=260,Text=label});box.SetBounds(285,y,440,28);Controls.Add(box);}
    void Append(string text){if(text==null)return;if(InvokeRequired){BeginInvoke(new Action<string>(Append),text);return;}log.AppendText(text+Environment.NewLine);}
    string Quote(string value){if(value.Contains("\"")||value.Contains("\r")||value.Contains("\n"))throw new Exception("Недопустимый символ в поле.");return "\""+value.TrimEnd('\\')+"\"";}
    async Task Run(bool remove) {
        if(remove && MessageBox.Show(this,"Вернуть исходные HTTPS-порты и удалить службу модуля? Kerio будет перезапущен.","Удаление",MessageBoxButtons.OKCancel)!=DialogResult.OK)return;
        string temp=Path.Combine(Path.GetTempPath(),"KerioSwitcher-"+Guid.NewGuid().ToString("N"));
        busy=true;install.Enabled=false;uninstall.Enabled=false;log.Clear();
        try {
            string args="-NoProfile -ExecutionPolicy Bypass -File "+Quote(Path.Combine(temp,"windows","Manage-KerioSwitcher.ps1"))+" -Mode "+(remove?"Uninstall":"Install")+" -HostName "+Quote(host.Text.Trim())+" -KerioPath "+Quote(kerio.Text.Trim())+" -InstallDir "+Quote(target.Text.Trim())+" -BackendPort "+port.Value;
            if(!remove && File.Exists(Path.Combine(target.Text.Trim(),"install-state.json"))) {
                args="-NoProfile -ExecutionPolicy Bypass -File "+Quote(Path.Combine(temp,"windows","Update-1.0.2.ps1"))+" -InstallDir "+Quote(target.Text.Trim());
            }
            Append("Подготовка файлов…");
            await Task.Run(()=>{
                Directory.CreateDirectory(temp);
                using(var input=Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))
                using(var archive=new ZipArchive(input,ZipArchiveMode.Read)) {
                    foreach(var entry in archive.Entries){
                        string path=Path.GetFullPath(Path.Combine(temp,entry.FullName));
                        if(!path.StartsWith(temp+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase))throw new Exception("Invalid archive path");
                        if(String.IsNullOrEmpty(entry.Name)){Directory.CreateDirectory(path);continue;}
                        Directory.CreateDirectory(Path.GetDirectoryName(path));entry.ExtractToFile(path);
                    }
                }
            });
            var start=new ProcessStartInfo {
                FileName=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),@"WindowsPowerShell\v1.0\powershell.exe"),
                Arguments=args,UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true,
                StandardOutputEncoding=System.Text.Encoding.UTF8,StandardErrorEncoding=System.Text.Encoding.UTF8
            };
            using(var process=new Process{StartInfo=start}){
                process.OutputDataReceived+=(s,e)=>Append(e.Data);process.ErrorDataReceived+=(s,e)=>Append(e.Data);
                process.Start();process.BeginOutputReadLine();process.BeginErrorReadLine();await Task.Run(()=>process.WaitForExit());
                if(process.ExitCode!=0)throw new Exception("Операция не завершена. Подробности в журнале выше.");
            }
            Append(remove?"Готово. Исходные HTTPS-настройки Kerio восстановлены.":"Готово. Обновите страницу веб-почты и откройте меню своего профиля.");
        }catch(Exception ex){Append("ОШИБКА: "+ex.Message);}
        finally{
            // Only this invocation's newly created directory is removed.
            try{if(Directory.Exists(temp))Directory.Delete(temp,true);}catch{}
            busy=false;install.Enabled=true;uninstall.Enabled=true;
        }
    }
    [STAThread] static void Main(string[] args){
        // Read-only build smoke check; does not extract files or change the system.
        if(args.Length==1&&args[0]=="--verify-package"){
            using(var input=Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))
            using(var zip=new ZipArchive(input,ZipArchiveMode.Read)){if(zip.GetEntry("server.mjs")==null||zip.GetEntry("runtime/node.exe")==null)Environment.Exit(2);}return;
        }
        Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);Application.Run(new SetupForm());
    }
}
