# Helper input (mouse + keyboard). Dijalankan oleh src/input.js, membaca perintah per baris dari stdin:
#   m <dx> <dy>          gerak relatif (pixel)
#   c <l|r|m>            klik
#   d <l|r|m>            tekan tombol mouse (untuk drag)
#   u <l|r|m>            lepas tombol mouse
#   s <delta>            scroll vertikal (120 = 1 notch, positif = ke atas)
#   h <delta>            scroll horizontal (positif = ke kanan)
#   t <base64 utf8>      ketik teks (Unicode; \n = Enter, \t = Tab)
#   k <vk> <mods>        tekan tombol virtual-key dengan modifier
#   kc <mods> <code>     tekan karakter (code point) dengan modifier, mis. Ctrl+C
# mods = bitmask: 1 Ctrl, 2 Alt, 4 Shift, 8 Win
# Proses berhenti otomatis saat stdin ditutup (server mati).
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class OwnRemoteInput {
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Explicit)]
    struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }

    [StructLayout(LayoutKind.Sequential)]
    struct INPUT { public uint type; public InputUnion u; }

    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern void mouse_event(uint flags, int dx, int dy, int data, UIntPtr extra);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    // Per-Monitor V2: koordinat cursor & monitor dalam piksel fisik, akurat juga di monitor dengan scaling berbeda
    static void MakeDpiAware() {
        try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch { }
        try { SetProcessDPIAware(); } catch { }
    }
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint mapType);
    [DllImport("user32.dll")] static extern short VkKeyScan(char ch);

    const uint LEFTDOWN = 0x02, LEFTUP = 0x04, RIGHTDOWN = 0x08, RIGHTUP = 0x10;
    const uint MIDDLEDOWN = 0x20, MIDDLEUP = 0x40, WHEEL = 0x800, HWHEEL = 0x1000;

    const uint INPUT_KEYBOARD = 1;
    const uint KEY_EXTENDED = 0x1, KEY_UP = 0x2, KEY_UNICODE = 0x4;
    const ushort VK_SHIFT = 0x10, VK_CONTROL = 0x11, VK_MENU = 0x12, VK_LWIN = 0x5B;
    const ushort VK_RETURN = 0x0D, VK_TAB = 0x09;

    static uint Down(string b) { return b == "r" ? RIGHTDOWN : b == "m" ? MIDDLEDOWN : LEFTDOWN; }
    static uint Up(string b) { return b == "r" ? RIGHTUP : b == "m" ? MIDDLEUP : LEFTUP; }

    static bool IsExtended(ushort vk) {
        // panah, Home/End, PgUp/PgDn, Insert/Delete, tombol Windows
        return (vk >= 0x21 && vk <= 0x28) || vk == 0x2D || vk == 0x2E || vk == 0x5B || vk == 0x5C;
    }

    static INPUT Vk(ushort vk, bool up) {
        var i = new INPUT();
        i.type = INPUT_KEYBOARD;
        i.u.ki.wVk = vk;
        i.u.ki.wScan = (ushort)MapVirtualKey(vk, 0);
        i.u.ki.dwFlags = (up ? KEY_UP : 0) | (IsExtended(vk) ? KEY_EXTENDED : 0);
        return i;
    }

    static INPUT Unicode(char ch, bool up) {
        var i = new INPUT();
        i.type = INPUT_KEYBOARD;
        i.u.ki.wScan = ch;
        i.u.ki.dwFlags = KEY_UNICODE | (up ? KEY_UP : 0);
        return i;
    }

    static void Send(INPUT[] inputs) {
        if (inputs.Length > 0) SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    static ushort[] ModKeys(int mods) {
        var list = new System.Collections.Generic.List<ushort>();
        if ((mods & 1) != 0) list.Add(VK_CONTROL);
        if ((mods & 2) != 0) list.Add(VK_MENU);
        if ((mods & 4) != 0) list.Add(VK_SHIFT);
        if ((mods & 8) != 0) list.Add(VK_LWIN);
        return list.ToArray();
    }

    static void PressKey(ushort vk, int mods) {
        var seq = new System.Collections.Generic.List<INPUT>();
        var modKeys = ModKeys(mods);
        foreach (var m in modKeys) seq.Add(Vk(m, false));
        seq.Add(Vk(vk, false));
        seq.Add(Vk(vk, true));
        for (int i = modKeys.Length - 1; i >= 0; i--) seq.Add(Vk(modKeys[i], true));
        Send(seq.ToArray());
    }

    static void TypeText(string text) {
        var seq = new System.Collections.Generic.List<INPUT>();
        foreach (char ch in text.Replace("\r\n", "\n")) {
            if (ch == '\n' || ch == '\r') { seq.Add(Vk(VK_RETURN, false)); seq.Add(Vk(VK_RETURN, true)); }
            else if (ch == '\t') { seq.Add(Vk(VK_TAB, false)); seq.Add(Vk(VK_TAB, true)); }
            else { seq.Add(Unicode(ch, false)); seq.Add(Unicode(ch, true)); }
        }
        Send(seq.ToArray());
    }

    // Karakter + modifier (mis. Ctrl+C): cari virtual-key sesuai layout keyboard aktif
    static void PressChar(int mods, char ch) {
        short scan = VkKeyScan(ch);
        if (scan == -1) { TypeText(ch.ToString()); return; }
        int shiftState = (scan >> 8) & 0xFF;
        int extra = ((shiftState & 1) != 0 ? 4 : 0) | ((shiftState & 2) != 0 ? 1 : 0) | ((shiftState & 4) != 0 ? 2 : 0);
        PressKey((ushort)(scan & 0xFF), mods | extra);
    }

    public static void Run() {
        MakeDpiAware();
        Console.Out.WriteLine("ready");
        Console.Out.Flush();

        string line;
        while ((line = Console.In.ReadLine()) != null) {
            try {
                string[] a = line.Trim().Split(' ');
                switch (a[0]) {
                    case "m": {
                        POINT p;
                        GetCursorPos(out p);
                        SetCursorPos(p.X + int.Parse(a[1]), p.Y + int.Parse(a[2]));
                        break;
                    }
                    case "c":
                        mouse_event(Down(a[1]), 0, 0, 0, UIntPtr.Zero);
                        mouse_event(Up(a[1]), 0, 0, 0, UIntPtr.Zero);
                        break;
                    case "d": mouse_event(Down(a[1]), 0, 0, 0, UIntPtr.Zero); break;
                    case "u": mouse_event(Up(a[1]), 0, 0, 0, UIntPtr.Zero); break;
                    case "s": mouse_event(WHEEL, 0, 0, int.Parse(a[1]), UIntPtr.Zero); break;
                    case "h": mouse_event(HWHEEL, 0, 0, int.Parse(a[1]), UIntPtr.Zero); break;
                    case "t": TypeText(Encoding.UTF8.GetString(Convert.FromBase64String(a[1]))); break;
                    case "k": PressKey((ushort)int.Parse(a[1]), int.Parse(a[2])); break;
                    case "kc": PressChar(int.Parse(a[1]), (char)int.Parse(a[2])); break;
                    case "q": return;
                }
            } catch (Exception e) {
                Console.Error.WriteLine(e.Message);
            }
        }
    }
}
"@

[OwnRemoteInput]::Run()
