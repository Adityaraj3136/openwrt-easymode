package com.example.easymode

import android.content.Context
import android.net.wifi.WifiManager
import fi.iki.elonen.NanoHTTPD
import java.io.IOException
import java.io.InputStream
import org.json.JSONArray
import org.json.JSONObject

/**
 * Local HTTP server that serves the EasyMode frontend and bridges all /api/ calls
 * to the OpenWrt router's ubus JSON-RPC endpoint natively in Kotlin.
 */
class EasyModeServer(private val context: Context, port: Int) : NanoHTTPD(port) {
    private val ubus = UbusClient()

    // These survive for the lifetime of the server process
    private var activeRouterIp = "192.168.1.1"
    private var activeSid = ""

    // ────────────────────────────────────────────────────
    // Gateway IP detection via Android WifiManager
    // ────────────────────────────────────────────────────
    private fun getGatewayIp(): String {
        try {
            @Suppress("DEPRECATION")
            val wm = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            val g = wm.dhcpInfo.gateway
            if (g != 0) {
                val b = ByteArray(4)
                b[0] = (g and 0xFF).toByte()
                b[1] = ((g shr 8) and 0xFF).toByte()
                b[2] = ((g shr 16) and 0xFF).toByte()
                b[3] = ((g shr 24) and 0xFF).toByte()
                return java.net.InetAddress.getByAddress(b).hostAddress ?: "192.168.1.1"
            }
        } catch (_: Exception) {}
        return "192.168.1.1"
    }

    // ────────────────────────────────────────────────────
    // Helpers
    // ────────────────────────────────────────────────────
    private fun ok(payload: JSONObject) =
        newFixedLengthResponse(Response.Status.OK, "application/json", payload.toString())

    private fun ok(payload: String) =
        newFixedLengthResponse(Response.Status.OK, "application/json", payload)

    private fun err(status: Response.Status, msg: String): Response {
        val body = JSONObject().put("error", JSONObject().put("code", "SERVER_ERROR").put("message", msg))
        return newFixedLengthResponse(status, "application/json", body.toString())
    }

    private fun uciOf(config: String): JSONObject {
        return try {
            ubus.call(activeRouterIp, activeSid, "uci", "get", JSONObject().put("config", config))
                .optJSONObject("values") ?: JSONObject()
        } catch (_: Exception) { JSONObject() }
    }

    private fun tryCall(obj: String, method: String, args: JSONObject? = null): JSONObject? {
        return try { ubus.call(activeRouterIp, activeSid, obj, method, args) } catch (_: Exception) { null }
    }

    // ────────────────────────────────────────────────────
    // Static file serving
    // ────────────────────────────────────────────────────
    override fun serve(session: IHTTPSession): Response {
        val uri = session.uri
        if (uri.startsWith("/api/")) return handleApi(session)

        var path = if (uri == "/") "index.html" else uri.trimStart('/')
        return try {
            val mimeType = getMimeTypeForFile(path)
            val stream: InputStream = context.assets.open("frontend/$path")
            newChunkedResponse(Response.Status.OK, mimeType, stream)
        } catch (_: IOException) {
            newFixedLengthResponse(Response.Status.NOT_FOUND, MIME_PLAINTEXT, "Not Found: $path")
        }
    }

    // ────────────────────────────────────────────────────
    // API routing
    // ────────────────────────────────────────────────────
    private fun handleApi(session: IHTTPSession): Response {
        val uri = session.uri
        val method = session.method

        // Parse POST body
        val bodyMap = HashMap<String, String>()
        if (method == Method.POST || method == Method.PUT) {
            try { session.parseBody(bodyMap) } catch (_: Exception) {}
        }
        val postJson = runCatching { JSONObject(bodyMap["postData"] ?: "{}") }.getOrDefault(JSONObject())

        // Auth guard — only /config and /login are public
        val sid = session.cookies.read("sysauth_http")
        val isPublic = uri == "/api/auth/config" || uri == "/api/auth/login"
        if (!isPublic && (sid.isNullOrEmpty() || sid != activeSid)) {
            return err(Response.Status.UNAUTHORIZED, "Session expired. Please log in again.")
        }

        return try {
            when (uri) {
                // ── Auth ──────────────────────────────────
                "/api/auth/config" -> {
                    ok(JSONObject()
                        .put("defaultRouterHost", getGatewayIp())
                        .put("demoAvailable", false))
                }

                "/api/auth/login" -> {
                    val host = postJson.optString("host", getGatewayIp()).trim()
                    activeRouterIp = host

                    val result = ubus.call(
                        host, "00000000000000000000000000000000",
                        "session", "login",
                        JSONObject()
                            .put("username", postJson.optString("username", "root"))
                            .put("password", postJson.optString("password", ""))
                    )
                    val newSid = result.getString("ubus_rpc_session")
                    activeSid = newSid

                    // Minimal capabilities object so the UI knows what to show
                    val caps = JSONObject().put("features", JSONObject()
                        .put("wirelessControl", true)
                        .put("wifiSchedule", false)
                        .put("fileRead", false))

                    val router = JSONObject()
                        .put("host", host)

                    val response = ok(JSONObject()
                        .put("router", router)
                        .put("capabilities", caps)
                        .put("username", postJson.optString("username", "root"))
                        .put("host", host))
                    response.addHeader("Set-Cookie", "sysauth_http=$newSid; Path=/; HttpOnly")
                    response
                }

                "/api/auth/session" -> {
                    val caps = JSONObject().put("features", JSONObject()
                        .put("wirelessControl", true)
                        .put("wifiSchedule", false)
                        .put("fileRead", false))
                    ok(JSONObject()
                        .put("host", activeRouterIp)
                        .put("username", "root")
                        .put("capabilities", caps))
                }

                "/api/auth/logout" -> {
                    try { ubus.call(activeRouterIp, activeSid, "session", "destroy") } catch (_: Exception) {}
                    activeSid = ""
                    val r = ok("{}")
                    r.addHeader("Set-Cookie", "sysauth_http=; Path=/; Max-Age=0")
                    r
                }

                // ── Full dashboard (single request) ──────
                "/api/status" -> buildDashboard()

                // ── Network status ───────────────────────
                "/api/status/network" -> buildNetworkStatus()

                // ── Mode status ───────────────────────────
                "/api/status/mode" -> buildModeStatus()

                // ── DHCP ─────────────────────────────────
                "/api/dhcp" -> {
                    val dhcpCfg = uciOf("dhcp")
                    val lanSection = dhcpCfg.keys().asSequence()
                        .mapNotNull { k -> dhcpCfg.optJSONObject(k)?.let { k to it } }
                        .firstOrNull { (_, v) ->
                            v.optString(".type") == "dhcp" &&
                                (v.optString("interface") == "lan" || v.optString(".name") == "lan")
                        }?.second

                    ok(JSONObject()
                        .put("enabled", lanSection?.optString("ignore") != "1")
                        .put("ipv6Enabled", false)
                        .put("routerIp", activeRouterIp)
                        .put("netmask", "255.255.255.0")
                        .put("start", lanSection?.optInt("start", 100) ?: 100)
                        .put("limit", lanSection?.optInt("limit", 150) ?: 150)
                        .put("leasetime", lanSection?.optString("leasetime", "12h") ?: "12h")
                        .put("dns", JSONArray())
                        .put("reservations", JSONArray())
                        .put("blocked", JSONArray()))
                }

                // ── Wi-Fi ────────────────────────────────
                "/api/wifi" -> buildWifiStatus()

                // ── Everything else is not yet ported ────
                else -> err(Response.Status.NOT_FOUND, "API endpoint $uri not yet implemented in Android app")
            }
        } catch (e: Exception) {
            err(Response.Status.INTERNAL_ERROR, e.message ?: "Internal error")
        }
    }

    // ────────────────────────────────────────────────────
    // Dashboard builder
    // ────────────────────────────────────────────────────
    private fun buildDashboard(): Response {
        val board = tryCall("system", "board") ?: JSONObject()
        val network = buildNetworkPayload()
        val mode = buildModePayload()
        val wifi = buildWifiPayload()

        val internet = JSONObject()
            .put("connected", network.optJSONObject("wan")?.optBoolean("up", false) ?: false)
            .put("reachable", true)

        val sysInfo = tryCall("system", "info")
        val memInfo = sysInfo?.optJSONObject("memory") ?: JSONObject()
        val memTotal = memInfo.optLong("total", 0)
        val memAvail = memInfo.optLong("available", 0).let { if (it > 0) it else memInfo.optLong("free", 0) + memInfo.optLong("buffered", 0) }
        val memUsed = if (memTotal > 0) memTotal - memAvail else 0
        val memPercent = if (memTotal > 0) Math.round((memUsed.toDouble() / memTotal.toDouble()) * 1000.0) / 10.0 else null

        val loadArr = sysInfo?.optJSONArray("load")
        val loadList = if (loadArr != null) {
            (0 until minOf(loadArr.length(), 3)).map { Math.round((loadArr.getDouble(it) / 65536.0) * 100.0) / 100.0 }
        } else null

        val memPayload = JSONObject()
            .put("total", memTotal)
            .put("used", memUsed)
            .put("available", memAvail)
            .put("percent", memPercent)
            .put("cached", memInfo.opt("cached"))
            .put("buffered", memInfo.opt("buffered"))

        // cpu: we don't have /proc/stat access so report null percent gracefully
        val cpuPayload = JSONObject()
            .put("percent", JSONObject.NULL)
            .put("available", false)
            .put("reason", "CPU usage not available in Android app")

        val system = JSONObject()
            .put("model", board.optString("model", "Router"))
            .put("hostname", board.optString("hostname", "OpenWrt"))
            .put("boardName", board.optString("board_name", ""))
            .put("processor", board.optString("system", ""))
            .put("firmware", board.optJSONObject("release")?.optString("description", "") ?: "")
            .put("version", board.optJSONObject("release")?.optString("version", "") ?: "")
            .put("kernel", board.optString("kernel", ""))
            .put("uptimeSeconds", sysInfo?.optLong("uptime", 0) ?: 0)
            .put("uptime", formatUptime(sysInfo?.optLong("uptime", 0) ?: 0))
            .put("memory", memPayload)
            .put("cpu", cpuPayload)
            .put("load", if (loadList != null) org.json.JSONArray(loadList) else JSONObject.NULL)

        val router = JSONObject()
            .put("host", activeRouterIp)
            .put("username", "root")
            .put("luciUrl", "http://$activeRouterIp/cgi-bin/luci")

        return ok(JSONObject()
            .put("fetchedAt", java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US).apply {
                timeZone = java.util.TimeZone.getTimeZone("UTC")
            }.format(java.util.Date()))
            .put("router", router)
            .put("system", system)
            .put("network", network)
            .put("internet", internet)
            .put("mode", mode)
            .put("wifi", wifi))
    }

    private fun formatUptime(seconds: Long): String {
        if (seconds <= 0) return "—"
        val d = seconds / 86400
        val h = (seconds % 86400) / 3600
        val m = (seconds % 3600) / 60
        return when {
            d > 0 -> "${d}d ${h}h"
            h > 0 -> "${h}h ${m}m"
            else -> "${m}m"
        }
    }

    // Kept for compatibility but buildDashboard no longer calls these directly
    private fun buildMemoryPayload(): JSONObject = JSONObject()
    private fun buildLoadAvgPayload(): JSONArray = JSONArray()


    // ────────────────────────────────────────────────────
    // Network status builder
    // ────────────────────────────────────────────────────
    private fun buildNetworkStatus(): Response = ok(buildNetworkPayload())

    private fun buildNetworkPayload(): JSONObject {
        val dump = tryCall("network.interface", "dump") ?: JSONObject()
        val interfaces = dump.optJSONArray("interface") ?: JSONArray()
        val devices = tryCall("network.device", "status") ?: JSONObject()

        // Pick WAN interface
        var wanIface: JSONObject? = null
        var lanIface: JSONObject? = null
        for (i in 0 until interfaces.length()) {
            val iface = interfaces.getJSONObject(i)
            val name = iface.optString("interface")
            when {
                name == "lan" -> lanIface = iface
                name == "wan" && iface.optBoolean("up") -> wanIface = iface
                wanIface == null && name.matches(Regex("wwan.*|wan_sta.*|repeater.*", RegexOption.IGNORE_CASE)) && iface.optBoolean("up") -> wanIface = iface
            }
        }
        // fallback: first routed non-lan interface
        if (wanIface == null) {
            for (i in 0 until interfaces.length()) {
                val iface = interfaces.getJSONObject(i)
                val name = iface.optString("interface")
                if (name != "lan" && name != "loopback" && iface.optBoolean("up")) {
                    val routes = iface.optJSONArray("route") ?: JSONArray()
                    for (r in 0 until routes.length()) {
                        if (routes.getJSONObject(r).optString("target") == "0.0.0.0") {
                            wanIface = iface; break
                        }
                    }
                    if (wanIface != null) break
                }
            }
        }

        fun firstIpv4(iface: JSONObject?): String? {
            val arr = iface?.optJSONArray("ipv4-address") ?: return null
            return if (arr.length() > 0) arr.getJSONObject(0).optString("address", null) else null
        }

        val wanIp = firstIpv4(wanIface)
        val wanDevice = wanIface?.optString("l3_device") ?: wanIface?.optString("device")
        val wanIsWireless = wanDevice?.matches(Regex("^(wlan|phy|wl).*", RegexOption.IGNORE_CASE)) == true
        val lanIp = firstIpv4(lanIface)

        // Ethernet links
        val ethernetLinks = JSONArray()
        devices.keys().forEach { name ->
            if (name.matches(Regex("^(eth|lan|wan|swp|sfp)[^.]*$", RegexOption.IGNORE_CASE))) {
                val dev = devices.optJSONObject(name) ?: return@forEach
                if (dev.optString("type") == "bridge") return@forEach
                ethernetLinks.put(JSONObject()
                    .put("name", name)
                    .put("up", dev.optBoolean("up"))
                    .put("carrier", dev.optBoolean("carrier"))
                    .put("speed", dev.opt("speed")))
            }
        }

        // DHCP config for LAN
        val dhcpCfg = uciOf("dhcp")
        val lanDhcpSection = dhcpCfg.keys().asSequence()
            .mapNotNull { k -> dhcpCfg.optJSONObject(k) }
            .firstOrNull { it.optString(".type") == "dhcp" && (it.optString("interface") == "lan" || it.optString(".name") == "lan") }
        val dhcpEnabled = lanDhcpSection?.optString("ignore") != "1"

        val wan = JSONObject()
            .put("present", wanIface != null)
            .put("interface", wanIface?.optString("interface"))
            .put("up", wanIface?.optBoolean("up") ?: false)
            .put("kind", if (wanIface == null) "none" else if (wanIsWireless) "wireless" else "ethernet")
            .put("proto", wanIface?.optString("proto"))
            .put("device", wanDevice)
            .put("ip", wanIp)
            .put("uptimeSeconds", wanIface?.optLong("uptime", 0) ?: 0)

        val lan = JSONObject()
            .put("present", lanIface != null)
            .put("up", lanIface?.optBoolean("up") ?: false)
            .put("ip", lanIp)
            .put("device", lanIface?.optString("l3_device") ?: lanIface?.optString("device"))
            .put("dhcpEnabled", dhcpEnabled)
            .put("clients", JSONObject()
                .put("count", null)
                .put("available", false)
                .put("reason", "Client counting not yet implemented in Android app")
                .put("devices", JSONArray()))

        return JSONObject()
            .put("wan", wan)
            .put("lan", lan)
            .put("ethernetLinks", ethernetLinks)
    }

    // ────────────────────────────────────────────────────
    // Mode status builder
    // ────────────────────────────────────────────────────
    private fun buildModeStatus(): Response = ok(buildModePayload())

    private fun buildModePayload(): JSONObject {
        val wireless = uciOf("wireless")
        var isRepeater = false
        wireless.keys().forEach { k ->
            val s = wireless.optJSONObject(k) ?: return@forEach
            if (s.optString(".type") == "wifi-iface" && s.optString("mode") == "sta") isRepeater = true
        }
        return JSONObject()
            .put("id", if (isRepeater) "repeater" else "router")
            .put("title", if (isRepeater) "Wi-Fi Repeater" else "Router")
            .put("internetSource", if (isRepeater) "Wireless Uplink" else "Ethernet WAN")
            .put("repeaterPaused", false)
    }

    // ────────────────────────────────────────────────────
    // Wi-Fi status builder
    // ────────────────────────────────────────────────────
    private fun buildWifiStatus(): Response = ok(JSONObject().put("supported", true).put("repeaterPaused", false).put("radios", buildWifiPayload().optJSONArray("radios") ?: JSONArray()))

    private fun buildWifiPayload(): JSONObject {
        val wireless = uciOf("wireless")
        val radios = JSONArray()

        wireless.keys().forEach { k ->
            val s = wireless.optJSONObject(k) ?: return@forEach
            if (s.optString(".type") != "wifi-device") return@forEach

            val band = when {
                s.optString("band").contains("5") -> "5GHz"
                s.optString("band").contains("6") -> "6GHz"
                else -> "2.4GHz"
            }

            // Collect SSIDs on this radio
            var ssid: String? = null
            wireless.keys().forEach { ik ->
                val iface = wireless.optJSONObject(ik) ?: return@forEach
                if (iface.optString(".type") == "wifi-iface" && iface.optString("device") == k && iface.optString("mode") == "ap") {
                    ssid = iface.optString("ssid", null)
                }
            }

            radios.put(JSONObject()
                .put("id", k)
                .put("band", band)
                .put("label", band)
                .put("enabled", s.optString("disabled") != "1")
                .put("ssid", ssid)
                .put("channel", s.opt("channel"))
                .put("clients", 0)
                .put("interfaces", JSONArray()))
        }

        return JSONObject()
            .put("supported", radios.length() > 0)
            .put("repeaterPaused", false)
            .put("radios", radios)
    }
}
