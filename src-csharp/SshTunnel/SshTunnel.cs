#nullable enable
using System;
using System.Collections.Concurrent;
using System.Net;
using System.Runtime.InteropServices;
using Renci.SshNet;

public static class SshTunnelLib
{
    // Active tunnels keyed by tunnel ID
    private static readonly ConcurrentDictionary<string, ForwardedPortLocal> ActiveTunnels = new();
    private static readonly ConcurrentDictionary<string, SshClient> ActiveClients = new();

    [UnmanagedCallersOnly(EntryPoint = "open_tunnel")]
    public static IntPtr OpenTunnel(
        IntPtr tunnelIdPtr,
        IntPtr sshHostPtr,
        int sshPort,
        IntPtr sshUserPtr,
        IntPtr sshKeyPathPtr,
        IntPtr sshPasswordPtr,
        IntPtr dbHostPtr,
        int dbPort)
    {
        try
        {
            var tunnelId = Marshal.PtrToStringUTF8(tunnelIdPtr) ?? "";
            var sshHost = Marshal.PtrToStringUTF8(sshHostPtr) ?? "";
            var sshUser = Marshal.PtrToStringUTF8(sshUserPtr) ?? "";
            var sshKeyPath = Marshal.PtrToStringUTF8(sshKeyPathPtr) ?? "";
            var sshPassword = Marshal.PtrToStringUTF8(sshPasswordPtr) ?? "";
            var dbHost = Marshal.PtrToStringUTF8(dbHostPtr) ?? "127.0.0.1";

            // Close existing tunnel with same ID if any
            CloseTunnelInternal(tunnelId);

            // Build authentication
            AuthenticationMethod auth;

            if (!string.IsNullOrEmpty(sshKeyPath))
            {
                auth = new PrivateKeyAuthenticationMethod(sshUser,
                    new PrivateKeyFile(sshKeyPath));
            }
            else if (!string.IsNullOrEmpty(sshPassword))
            {
                auth = new PasswordAuthenticationMethod(sshUser, sshPassword);
            }
            else
            {
                return Marshal.StringToCoTaskMemUTF8(
                    "{\"error\":\"No SSH authentication provided — supply a key file or password\"}");
            }

            var connInfo = new ConnectionInfo(sshHost, sshPort, sshUser, auth);
            connInfo.Timeout = TimeSpan.FromSeconds(15);

            var client = new SshClient(connInfo);
            client.Connect();

            if (!client.IsConnected)
                return Marshal.StringToCoTaskMemUTF8(
                    "{\"error\":\"SSH connection failed\"}");

            // Find a free local port
            int localPort = GetFreePort();

            // Open port forward: localhost:localPort → dbHost:dbPort on the SSH server
            var forwardedPort = new ForwardedPortLocal(
                "127.0.0.1", (uint)localPort,
                dbHost, (uint)dbPort);

            client.AddForwardedPort(forwardedPort);
            forwardedPort.Start();

            // Wait until the port is actually listening (up to 3 seconds)
            var deadline = DateTime.UtcNow.AddSeconds(3);
            while (!forwardedPort.IsStarted && DateTime.UtcNow < deadline)
                System.Threading.Thread.Sleep(50);

            if (!forwardedPort.IsStarted)
                return Marshal.StringToCoTaskMemUTF8(
                    "{\"error\":\"Tunnel port failed to start listening\"}");

            ActiveClients[tunnelId] = client;
            ActiveTunnels[tunnelId] = forwardedPort;

            return Marshal.StringToCoTaskMemUTF8(
                $"{{\"localPort\":{localPort},\"error\":null}}");
        }
        catch (Exception ex)
        {
            return Marshal.StringToCoTaskMemUTF8(
                $"{{\"error\":\"{ex.Message.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", "\\n")}\"}}");
        }
    }

    [UnmanagedCallersOnly(EntryPoint = "close_tunnel")]
    public static void CloseTunnel(IntPtr tunnelIdPtr)
    {
        var tunnelId = Marshal.PtrToStringUTF8(tunnelIdPtr) ?? "";
        CloseTunnelInternal(tunnelId);
    }

    [UnmanagedCallersOnly(EntryPoint = "is_tunnel_open")]
    public static int IsTunnelOpen(IntPtr tunnelIdPtr)
    {
        var tunnelId = Marshal.PtrToStringUTF8(tunnelIdPtr) ?? "";
        return ActiveTunnels.TryGetValue(tunnelId, out var port)
            && port.IsStarted ? 1 : 0;
    }

    private static void CloseTunnelInternal(string tunnelId)
    {
        if (ActiveTunnels.TryRemove(tunnelId, out var port))
        {
            try { port.Stop(); } catch { }
            try { port.Dispose(); } catch { }
        }
        if (ActiveClients.TryRemove(tunnelId, out var client))
        {
            try { client.Disconnect(); } catch { }
            try { client.Dispose(); } catch { }
        }
    }

    private static int GetFreePort()
    {
        var listener = new System.Net.Sockets.TcpListener(
            IPAddress.Loopback, 0);
        listener.Start();
        int port = ((IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        return port;
    }
}