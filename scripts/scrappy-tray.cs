// Tiny always-on tray host. Windows only shows a notify icon while SOME
// process is running — if that process is Electron, ending Electron in Task
// Manager yanks the icon. This exe is separate, so the hidden-icons entry
// survives and can start him again.
//
// Build: powershell -File scripts/build-tray.ps1

using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Management;
using System.Threading;
using System.Windows.Forms;

static class Home
{
    public static string ProjectRoot;
    public static string ElectronExe;
    public static string IconPath;

    public static void Load()
    {
        string file = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "scrappy-home.txt");
        if (!File.Exists(file))
            throw new FileNotFoundException("Missing scrappy-home.txt next to Scrappy.exe");
        foreach (string line in File.ReadAllLines(file))
        {
            int eq = line.IndexOf('=');
            if (eq < 1) continue;
            string key = line.Substring(0, eq).Trim();
            string val = line.Substring(eq + 1).Trim();
            if (key.Equals("projectRoot", StringComparison.OrdinalIgnoreCase)) ProjectRoot = val;
            else if (key.Equals("electronExe", StringComparison.OrdinalIgnoreCase)) ElectronExe = val;
            else if (key.Equals("iconPath", StringComparison.OrdinalIgnoreCase)) IconPath = val;
        }
        if (string.IsNullOrEmpty(ProjectRoot) || string.IsNullOrEmpty(ElectronExe))
            throw new InvalidOperationException("scrappy-home.txt is incomplete");
    }
}

static class Buddy
{
    public static void Start()
    {
        var psi = new ProcessStartInfo();
        psi.FileName = Home.ElectronExe;
        psi.Arguments = "\"" + Home.ProjectRoot + "\"";
        psi.WorkingDirectory = Home.ProjectRoot;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        try { psi.EnvironmentVariables["SCRAPPY_FROM_TRAY"] = "1"; }
        catch { }
        Process.Start(psi);
    }

    public static void Stop()
    {
        KillNamed("electron.exe");
        foreach (string name in new string[] { "python.exe", "pythonw.exe" })
            KillNamed(name);
    }

    static void KillNamed(string image)
    {
        string needle = Home.ProjectRoot;
        try
        {
            var q = new ManagementObjectSearcher(
                "SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name='" + image + "'");
            foreach (ManagementObject mo in q.Get())
            {
                string cmd = Convert.ToString(mo["CommandLine"]) ?? "";
                if (cmd.IndexOf(needle, StringComparison.OrdinalIgnoreCase) < 0) continue;
                int pid = Convert.ToInt32(mo["ProcessId"]);
                try { Process.GetProcessById(pid).Kill(); }
                catch { }
            }
        }
        catch
        {
            // WMI unavailable — best-effort by process name only is too broad.
        }
    }
}

sealed class TrayApp : ApplicationContext
{
    readonly NotifyIcon icon;

    public TrayApp()
    {
        Icon face = null;
        try
        {
            if (!string.IsNullOrEmpty(Home.IconPath) && File.Exists(Home.IconPath))
                face = new Icon(Home.IconPath);
        }
        catch { }

        var menu = new ContextMenuStrip();
        menu.Items.Add("Start Scrappy", null, delegate { Buddy.Start(); });
        menu.Items.Add("Turn off Scrappy", null, delegate { Buddy.Stop(); });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Remove this icon", null, delegate { Exit(); });

        icon = new NotifyIcon();
        icon.Icon = face ?? SystemIcons.Application;
        icon.Text = "Scrappy — click to start";
        icon.ContextMenuStrip = menu;
        icon.Visible = true;
        icon.MouseClick += delegate(object sender, MouseEventArgs e)
        {
            if (e.Button == MouseButtons.Left) Buddy.Start();
        };
    }

    void Exit()
    {
        icon.Visible = false;
        icon.Dispose();
        ExitThread();
    }
}

static class Program
{
    const string MutexName = @"Local\ScrappyTrayHost";

    [STAThread]
    static void Main(string[] args)
    {
        bool noLaunch = false;
        foreach (string a in args)
            if (a.Equals("--no-launch", StringComparison.OrdinalIgnoreCase)) noLaunch = true;

        Home.Load();

        bool created;
        using (var mutex = new Mutex(true, MutexName, out created))
        {
            if (!created)
            {
                if (!noLaunch) Buddy.Start();
                return;
            }

            if (!noLaunch) Buddy.Start();

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new TrayApp());
        }
    }
}
