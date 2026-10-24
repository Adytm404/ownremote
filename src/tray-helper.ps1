# Ikon system tray untuk mode background. Dijalankan oleh src/tray.js.
# stdin (dari node), satu perintah per baris:
#   state <url>\t<code>\t<online>\t<paired>\t<allowPairing 1|0>\t<publicUrl>
#   notify <judul>\t<teks>
#   quit
# stdout (ke node): "ready", "cmd open", "cmd newcode", "cmd togglepair", "cmd stop"
# Jika stdin ditutup (server mati), ikon dihapus dan proses berhenti.
param([string]$Render)
$ErrorActionPreference = 'Stop'

Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @"
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

public static class OwnRemoteTray {
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr handle);

    static NotifyIcon icon;
    static Control ui;
    static ToolStripMenuItem urlItem, publicItem, codeItem, devicesItem, pairItem;
    static Icon idleIcon, activeIcon;
    static string url = "", publicUrl = "", code = "";

    static void Emit(string s) {
        Console.Out.WriteLine(s);
        Console.Out.Flush();
    }

    // Panah cursor hijau limau dengan outline gelap; titik hijau = ada perangkat terhubung.
    public static Bitmap Draw(bool active, int size) {
        var bmp = new Bitmap(size, size);
        float k = size / 32f;
        using (var g = Graphics.FromImage(bmp)) {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.Clear(Color.Transparent);
            var pts = new PointF[] {
                new PointF(5 * k, 2 * k), new PointF(5 * k, 26 * k), new PointF(11 * k, 20.5f * k),
                new PointF(15 * k, 29.5f * k), new PointF(19.5f * k, 27.5f * k), new PointF(15.5f * k, 18.5f * k),
                new PointF(23.5f * k, 18.5f * k)
            };
            using (var outline = new Pen(Color.FromArgb(255, 13, 15, 20), 3.2f * k)) {
                outline.LineJoin = LineJoin.Round;
                g.DrawPolygon(outline, pts);
            }
            using (var fill = new SolidBrush(Color.FromArgb(255, 198, 244, 91))) g.FillPolygon(fill, pts);
            if (active) {
                float d = 13 * k, x = size - d - 0.5f * k, y = size - d - 0.5f * k;
                using (var ring = new SolidBrush(Color.FromArgb(255, 13, 15, 20))) g.FillEllipse(ring, x - 1.5f * k, y - 1.5f * k, d + 3 * k, d + 3 * k);
                using (var dot = new SolidBrush(Color.FromArgb(255, 74, 222, 128))) g.FillEllipse(dot, x, y, d, d);
            }
        }
        return bmp;
    }

    static Icon MakeIcon(bool active) {
        int size = Math.Max(16, SystemInformation.SmallIconSize.Width);
        using (var bmp = Draw(active, size)) {
            IntPtr h = bmp.GetHicon();
            var tmp = Icon.FromHandle(h);
            var copy = (Icon)tmp.Clone();
            DestroyIcon(h);
            return copy;
        }
    }

    public static void Run() {
        try { SetProcessDPIAware(); } catch { }
        Application.EnableVisualStyles();
        ui = new Control();
        var handle = ui.Handle; // paksa handle dibuat agar BeginInvoke bisa dipakai dari thread pembaca

        idleIcon = MakeIcon(false);
        activeIcon = MakeIcon(true);

        var menu = new ContextMenuStrip();
        var title = new ToolStripMenuItem("OwnRemote - running in background");
        title.Enabled = false;
        urlItem = new ToolStripMenuItem("Open on phone: -", null, (s, e) => Copy(url, "Address copied"));
        publicItem = new ToolStripMenuItem("Internet: -", null, (s, e) => Copy(publicUrl, "Public URL copied"));
        publicItem.Visible = false;
        codeItem = new ToolStripMenuItem("Pairing code: -", null, (s, e) => Copy(code, "Pairing code copied"));
        devicesItem = new ToolStripMenuItem("Devices: -");
        devicesItem.Enabled = false;
        var open = new ToolStripMenuItem("Open OwnRemote menu", null, (s, e) => Emit("cmd open"));
        open.Font = new Font(open.Font, FontStyle.Bold);
        var newCode = new ToolStripMenuItem("Generate new pairing code", null, (s, e) => Emit("cmd newcode"));
        pairItem = new ToolStripMenuItem("Lock pairing", null, (s, e) => Emit("cmd togglepair"));
        var stop = new ToolStripMenuItem("Stop server", null, (s, e) => Emit("cmd stop"));
        menu.Items.AddRange(new ToolStripItem[] {
            title, new ToolStripSeparator(),
            urlItem, publicItem, codeItem, devicesItem, new ToolStripSeparator(),
            open, newCode, pairItem, new ToolStripSeparator(),
            stop
        });

        icon = new NotifyIcon();
        icon.Icon = idleIcon;
        icon.Text = "OwnRemote - running";
        icon.ContextMenuStrip = menu;
        icon.MouseDoubleClick += (s, e) => { if (e.Button == MouseButtons.Left) Emit("cmd open"); };
        icon.Visible = true;

        var reader = new Thread(ReadLoop);
        reader.IsBackground = true;
        reader.Start();

        Emit("ready");
        Application.Run();
        icon.Visible = false;
        icon.Dispose();
    }

    static void ReadLoop() {
        string line;
        while ((line = Console.In.ReadLine()) != null) {
            string l = line;
            try { ui.BeginInvoke((MethodInvoker)(() => Handle(l))); } catch { }
        }
        try { ui.BeginInvoke((MethodInvoker)(() => Quit())); } catch { }
    }

    static void Quit() {
        icon.Visible = false;
        Application.ExitThread();
    }

    static void Handle(string line) {
        try {
            int sp = line.IndexOf(' ');
            string cmd = sp < 0 ? line : line.Substring(0, sp);
            string[] f = (sp < 0 ? "" : line.Substring(sp + 1)).Split('\t');
            switch (cmd) {
                case "state": {
                    url = f[0];
                    code = f[1];
                    int online = int.Parse(f[2]);
                    urlItem.Text = url.Length > 0 ? "Open on phone: " + url + "   (click to copy)" : "No network detected";
                    codeItem.Text = "Pairing code: " + code.Substring(0, 3) + " " + code.Substring(3) + "   (click to copy)";
                    devicesItem.Text = "Devices: " + online + " online / " + f[3] + " paired";
                    pairItem.Text = f[4] == "1" ? "Lock pairing (reject new devices)" : "Unlock pairing";
                    publicUrl = f.Length > 5 ? f[5] : "";
                    publicItem.Visible = publicUrl.Length > 0;
                    publicItem.Text = "Internet (Cloudflare): " + publicUrl + "   (click to copy)";
                    icon.Icon = online > 0 ? activeIcon : idleIcon;
                    string tip = "OwnRemote - running\n" + (online > 0 ? online + " device(s) connected" : "Code " + code.Substring(0, 3) + " " + code.Substring(3));
                    icon.Text = tip.Length > 63 ? tip.Substring(0, 63) : tip;
                    break;
                }
                case "notify":
                    icon.ShowBalloonTip(3000, f[0], f.Length > 1 && f[1].Length > 0 ? f[1] : " ", ToolTipIcon.Info);
                    break;
                case "quit":
                    Quit();
                    break;
            }
        } catch (Exception e) {
            Console.Error.WriteLine(e.Message);
        }
    }

    static void Copy(string text, string title) {
        if (string.IsNullOrEmpty(text)) return;
        try {
            Clipboard.SetText(text);
            icon.ShowBalloonTip(1500, title, text, ToolTipIcon.None);
        } catch { }
    }
}
"@

if ($Render) {
    # mode uji: simpan gambar ikon sebagai PNG
    [OwnRemoteTray]::Draw($false, 64).Save("$Render-idle.png")
    [OwnRemoteTray]::Draw($true, 64).Save("$Render-active.png")
    exit 0
}

[OwnRemoteTray]::Run()
