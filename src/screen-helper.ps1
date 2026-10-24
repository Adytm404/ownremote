# Helper tangkap layar untuk preview di HP. Dijalankan oleh src/screen.js.
# stdin (teks, satu perintah per baris):
#   f <maxWidth> <quality>   ambil 1 frame dari monitor tempat cursor berada (JPEG)
#   c <1|0>                  nyalakan/matikan laporan posisi cursor (~60x per detik, hanya saat berubah)
#   q                        keluar
# stdout (biner): [1 byte tipe][int32 LE panjang][payload]
#   'R' siap | 'F' frame: 6x int32 (left, top, width, height, imgW, imgH) + JPEG
#   'C' cursor: 2x int32 (x, y) | 'E' error: teks UTF-8
$ErrorActionPreference = 'Stop'

Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @"
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

public static class OwnRemoteScreen {
    [StructLayout(LayoutKind.Sequential)]
    struct POINT { public int X; public int Y; }

    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    // Per-Monitor V2: koordinat cursor & monitor dalam piksel fisik, akurat juga di monitor dengan scaling berbeda
    static void MakeDpiAware() {
        try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch { }
        try { SetProcessDPIAware(); } catch { }
    }
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);

    static readonly object outLock = new object();
    static Stream stdout;
    static volatile bool cursorOn = false;
    static ImageCodecInfo jpeg;

    static void Packet(char type, byte[] payload) {
        lock (outLock) {
            stdout.WriteByte((byte)type);
            stdout.Write(BitConverter.GetBytes(payload.Length), 0, 4);
            stdout.Write(payload, 0, payload.Length);
            stdout.Flush();
        }
    }

    static void CursorLoop() {
        int lx = int.MinValue, ly = int.MinValue;
        while (true) {
            if (cursorOn) {
                POINT p;
                if (GetCursorPos(out p) && (p.X != lx || p.Y != ly)) {
                    lx = p.X;
                    ly = p.Y;
                    var b = new byte[8];
                    BitConverter.GetBytes(p.X).CopyTo(b, 0);
                    BitConverter.GetBytes(p.Y).CopyTo(b, 4);
                    try { Packet('C', b); } catch { return; }
                }
            } else {
                lx = int.MinValue;
            }
            Thread.Sleep(15); // ~60 Hz, hanya kirim saat posisi berubah
        }
    }

    static void Frame(int maxWidth, long quality) {
        POINT p;
        GetCursorPos(out p);
        Rectangle r = Screen.FromPoint(new Point(p.X, p.Y)).Bounds;
        int w = Math.Max(160, Math.Min(maxWidth, r.Width));
        int h = (int)Math.Round((double)r.Height * w / r.Width);

        using (var full = new Bitmap(r.Width, r.Height, PixelFormat.Format24bppRgb))
        using (var small = new Bitmap(w, h, PixelFormat.Format24bppRgb)) {
            using (var g = Graphics.FromImage(full)) {
                g.CopyFromScreen(r.Left, r.Top, 0, 0, r.Size, CopyPixelOperation.SourceCopy);
            }
            using (var g2 = Graphics.FromImage(small)) {
                g2.InterpolationMode = InterpolationMode.HighQualityBilinear;
                g2.PixelOffsetMode = PixelOffsetMode.Half;
                g2.DrawImage(full, 0, 0, w, h);
            }
            var ms = new MemoryStream();
            ms.Write(new byte[24], 0, 24);
            var ep = new EncoderParameters(1);
            ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, quality);
            small.Save(ms, jpeg, ep);
            byte[] buf = ms.ToArray();
            int[] hdr = { r.Left, r.Top, r.Width, r.Height, w, h };
            for (int i = 0; i < hdr.Length; i++) BitConverter.GetBytes(hdr[i]).CopyTo(buf, i * 4);
            Packet('F', buf);
        }
    }

    public static void Run() {
        MakeDpiAware();
        stdout = Console.OpenStandardOutput();
        foreach (var c in ImageCodecInfo.GetImageEncoders()) if (c.MimeType == "image/jpeg") jpeg = c;

        var t = new Thread(CursorLoop);
        t.IsBackground = true;
        t.Start();

        Packet('R', new byte[0]);
        string line;
        while ((line = Console.In.ReadLine()) != null) {
            try {
                string[] a = line.Trim().Split(' ');
                switch (a[0]) {
                    case "f": Frame(int.Parse(a[1]), long.Parse(a[2])); break;
                    case "c": cursorOn = a[1] == "1"; break;
                    case "q": return;
                }
            } catch (Exception e) {
                // mis. layar terkunci / UAC aktif: desktop tidak bisa ditangkap
                Packet('E', Encoding.UTF8.GetBytes(e.Message));
            }
        }
    }
}
"@

[OwnRemoteScreen]::Run()
