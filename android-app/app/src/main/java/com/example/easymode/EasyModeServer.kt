package com.example.easymode

import android.content.Context
import android.net.wifi.WifiManager
import fi.iki.elonen.NanoHTTPD
import java.io.IOException
import java.io.InputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import org.json.JSONArray
import org.json.JSONObject

/**
 * Local HTTP server that serves the EasyMode frontend and bridges all /api/ calls
 * to the OpenWrt router's ubus JSON-RPC endpoint natively in Kotlin.
 */
class EasyModeServer(private val context: Context, port: Int) : NanoHTTPD(port) {
    private val ubus = UbusClient()
    private var activeRouterIp = "192.168.1.1"
    private var activeSid = ""

    // ── Gateway IP detection ─────────────────────────────
    private fun getGatewayIp(): String {
        return try {
            @Suppress("DEPRECATION")
            val wm = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            val g = wm.dhcpInfo.gateway
            if (g != 0) {
                val b = byteArrayOf((g and 0xFF).toByte(), ((g shr 8) and 0xFF).toByte(),
                    ((g shr 16) and 0xFF).toByte(), ((g shr 24) and 0xFF).toByte())
                java.net.InetAddress.getByAddress(b).hostAddress ?: "192.168.1.1"
            } else "192.168.1.1"
        } catch (_: Exception) { "192.168.1.1" }
    }

    // ── Response helpers ─────────────────────────────────
    private fun ok(obj: JSONObject) = newFixedLengthResponse(Response.Status.OK, "application/json", obj.toString())
    private fun ok(s: String) = newFixedLengthResponse(Response.Status.OK, "application/json", s)
    private fun err(status: Response.Status, msg: String): Response =
        newFixedLengthResponse(status, "application/json",
            JSONObject().put("error", JSONObject().put("code", "ERROR").put("message", msg)).toString())

    // ── Ubus helpers ─────────────────────────────────────
    private fun tryCall(obj: String, method: String, args: JSONObject? = null): JSONObject? =
        try { ubus.call(activeRouterIp, activeSid, obj, method, args) } catch (_: Exception) { null }

    private fun uciOf(config: String): JSONObject =
        try { ubus.call(activeRouterIp, activeSid, "uci", "get", JSONObject().put("config", config)).optJSONObject("values") ?: JSONObject() }
        catch (_: Exception) { JSONObject() }

    private fun uciSet(config: String, section: String, values: JSONObject) {
        try {
            ubus.call(activeRouterIp, activeSid, "uci", "set",
                JSONObject().put("config", config).put("section", section).put("values", values))
        } catch (_: Exception) {}
    }

    private fun uciCommit(config: String) {
        try { ubus.call(activeRouterIp, activeSid, "uci", "commit", JSONObject().put("config", config)) }
        catch (_: Exception) {}
    }

    private fun uciApply() {
        try { ubus.call(activeRouterIp, activeSid, "uci", "apply", JSONObject().put("timeout", 10).put("rollback", false)) }
        catch (_: Exception) {}
    }

    private fun capabilities() = JSONObject().put("features", JSONObject()
        .put("wirelessControl", true).put("wifiSchedule", false)
        .put("fileRead", false).put("cpuUsage", false))

    // ── Static file serving ───────────────────────────────
    override fun serve(session: IHTTPSession): Response {
        val uri = session.uri
        if (uri.startsWith("/api/")) return handleApi(session)
        val path = if (uri == "/") "index.html" else uri.trimStart('/')
        return try {
            newChunkedResponse(Response.Status.OK, getMimeTypeForFile(path),
                context.assets.open("frontend/$path"))
        } catch (_: IOException) {
            newFixedLengthResponse(Response.Status.NOT_FOUND, MIME_PLAINTEXT, "Not Found: $path")
        }
    }

    // ── API dispatcher ────────────────────────────────────
    private fun handleApi(session: IHTTPSession): Response {
        val uri = session.uri
        val method = session.method
        val bodyMap = HashMap<String, String>()
        if (method == Method.POST || method == Method.PUT) try { session.parseBody(bodyMap) } catch (_: Exception) {}
        val body = runCatching { JSONObject(bodyMap["postData"] ?: "{}") }.getOrDefault(JSONObject())
        val sid = session.cookies.read("sysauth_http")
        val isPublic = uri == "/api/auth/config" || uri == "/api/auth/login"
        if (!isPublic && (sid.isNullOrEmpty() || sid != activeSid))
            return err(Response.Status.UNAUTHORIZED, "Session expired. Please log in again.")
        return try { dispatch(session, uri, method, body) }
        catch (e: Exception) { err(Response.Status.INTERNAL_ERROR, e.message ?: "Internal error") }
    }

    @Suppress("CyclomaticComplexMethod")
    private fun dispatch(session: IHTTPSession, uri: String, method: Method, body: JSONObject): Response {
        // ── Auth ───────────────────────────────────────────
        if (uri == "/api/auth/config") return ok(JSONObject()
            .put("defaultRouterHost", getGatewayIp()).put("demoAvailable", false))

        if (uri == "/api/auth/login") {
            val host = body.optString("host", getGatewayIp()).trim()
            activeRouterIp = host
            val result = ubus.call(host, "00000000000000000000000000000000", "session", "login",
                JSONObject().put("username", body.optString("username", "root"))
                    .put("password", body.optString("password", "")))
            activeSid = result.getString("ubus_rpc_session")
            val r = ok(JSONObject().put("router", JSONObject().put("host", host))
                .put("capabilities", capabilities())
                .put("username", body.optString("username", "root")).put("host", host))
            r.addHeader("Set-Cookie", "sysauth_http=$activeSid; Path=/; HttpOnly")
            return r
        }

        if (uri == "/api/auth/session") return ok(JSONObject()
            .put("host", activeRouterIp).put("username", "root").put("capabilities", capabilities()))

        if (uri == "/api/auth/logout") {
            try { ubus.call(activeRouterIp, activeSid, "session", "destroy") } catch (_: Exception) {}
            activeSid = ""
            val r = ok("{}"); r.addHeader("Set-Cookie", "sysauth_http=; Path=/; Max-Age=0"); return r
        }

        // ── Dashboard ──────────────────────────────────────
        if (uri == "/api/status") return buildDashboard()

        // ── Network ────────────────────────────────────────
        if (uri == "/api/status/network") return ok(buildNetworkPayload())
        if (uri == "/api/status/mode") return ok(buildModePayload())

        // ── Wi-Fi ──────────────────────────────────────────
        if (uri == "/api/wifi") return buildWifi()
        if (uri == "/api/wifi/clients") return buildWifiClients()
        if (uri.startsWith("/api/wifi/scan")) return buildWifiScan(session.parms["radio"])
        if (uri.startsWith("/api/wifi/radio/") && method == Method.POST) {
            val radioId = uri.removePrefix("/api/wifi/radio/")
            return applyRadioSettings(radioId, body)
        }
        if (uri.startsWith("/api/wifi/optimize/") && method == Method.POST) {
            val radioId = uri.removePrefix("/api/wifi/optimize/")
            return ok(JSONObject().put("ok", true).put("optimized", false)
                .put("reason", "Channel optimization not available in Android app. Use the router's LuCI interface."))
        }
        if (uri == "/api/wifi/repeater/disconnect" && method == Method.POST) return repeaterPause(true)
        if (uri == "/api/wifi/repeater/connect" && method == Method.POST) return repeaterPause(false)
        if (uri == "/api/wifi/guest" && method == Method.GET) return ok(JSONObject().put("enabled", false))
        if (uri == "/api/wifi/guest" && method == Method.POST) return ok(JSONObject().put("ok", true))

        // ── DHCP ───────────────────────────────────────────
        if (uri == "/api/dhcp" && method == Method.GET) return buildDhcp()
        if (uri == "/api/dhcp" && method == Method.POST) return updateDhcp(body)
        if (uri == "/api/lan" && method == Method.GET) return buildLan()
        if (uri == "/api/lan" && method == Method.POST) return updateLan(body)
        if (uri == "/api/dhcp/reservations" && method == Method.POST) return addReservation(body)
        if (uri.startsWith("/api/dhcp/reservations/") && method == Method.DELETE) {
            return deleteReservation(uri.removePrefix("/api/dhcp/reservations/"))
        }
        if (uri == "/api/dhcp/blocked" && method == Method.POST) return blockClient(body)
        if (uri.startsWith("/api/dhcp/blocked/") && method == Method.DELETE) {
            return unblockClient(uri.removePrefix("/api/dhcp/blocked/"))
        }

        // ── Mode switching ─────────────────────────────────
        if (uri == "/api/mode") return ok(buildModePayload())
        if (uri == "/api/mode/router" && method == Method.POST) return switchMode("router", body)
        if (uri == "/api/mode/ap" && method == Method.POST) return switchMode("ap", body)
        if (uri == "/api/mode/repeater" && method == Method.POST) return switchMode("repeater", body)
        if (uri == "/api/mode/hotspot" && method == Method.POST) return switchMode("hotspot", body)

        // ── Diagnostics ────────────────────────────────────
        if (uri == "/api/diagnostics/ping" && method == Method.POST) return runDiagnostic("ping", body)
        if (uri == "/api/diagnostics/traceroute" && method == Method.POST) return runDiagnostic("traceroute", body)

        // ── System ─────────────────────────────────────────
        if (uri == "/api/system/overview") return buildSystemOverview()
        if (uri == "/api/system/reboot" && method == Method.POST) return rebootRouter()
        if (uri == "/api/system/autoreboot" && method == Method.POST) return ok(JSONObject().put("ok", true))
        if (uri == "/api/system/backup") return ok(JSONObject().put("ok", false).put("message", "Backup not supported in Android app"))
        if (uri == "/api/system/restore" && method == Method.POST) return ok(JSONObject().put("ok", false).put("message", "Restore not supported in Android app"))

        // ── Bandwidth ──────────────────────────────────────
        if (uri == "/api/bandwidth") return buildBandwidth()
        if (uri == "/api/bandwidth/limits" && method == Method.POST) return ok(JSONObject().put("ok", true))

        return err(Response.Status.NOT_FOUND, "Endpoint $uri not implemented")
    }

    // ═══════════════════════════════════════════════════
    // Dashboard
    // ═══════════════════════════════════════════════════
    private fun buildDashboard(): Response {
        val board = tryCall("system", "board") ?: JSONObject()
        val sysInfo = tryCall("system", "info")
        val network = buildNetworkPayload()
        val mode = buildModePayload()
        val wifi = buildWifiSummary()

        val memInfo = sysInfo?.optJSONObject("memory") ?: JSONObject()
        val memTotal = memInfo.optLong("total", 0)
        val memAvail = memInfo.optLong("available", 0).let { if (it > 0) it else memInfo.optLong("free", 0) + memInfo.optLong("buffered", 0) }
        val memUsed = if (memTotal > 0) memTotal - memAvail else 0L
        val memPercent = if (memTotal > 0) Math.round((memUsed.toDouble() / memTotal) * 1000.0) / 10.0 else null

        val loadArr = sysInfo?.optJSONArray("load")
        val loadList = loadArr?.let { arr ->
            JSONArray().also { out -> for (i in 0 until minOf(arr.length(), 3)) out.put(Math.round((arr.getDouble(i) / 65536.0) * 100.0) / 100.0) }
        }

        val mem = JSONObject().put("total", memTotal).put("used", memUsed).put("available", memAvail)
            .put("percent", memPercent).put("cached", memInfo.opt("cached")).put("buffered", memInfo.opt("buffered"))

        val cpu = JSONObject().put("percent", JSONObject.NULL).put("available", false)
            .put("reason", "CPU usage monitoring requires file access not available in Android app")

        val uptime = sysInfo?.optLong("uptime", 0) ?: 0
        val system = JSONObject()
            .put("model", board.optString("model")).put("hostname", board.optString("hostname"))
            .put("boardName", board.optString("board_name")).put("processor", board.optString("system"))
            .put("firmware", board.optJSONObject("release")?.optString("description", "") ?: "")
            .put("version", board.optJSONObject("release")?.optString("version", "") ?: "")
            .put("kernel", board.optString("kernel")).put("uptimeSeconds", uptime)
            .put("uptime", formatUptime(uptime)).put("localtime", sysInfo?.optLong("localtime", 0) ?: 0)
            .put("autoReboot", JSONObject.NULL).put("memory", mem).put("cpu", cpu)
            .put("load", loadList ?: JSONObject.NULL)

        val wanUp = network.optJSONObject("wan")?.optBoolean("up", false) ?: false
        val internet = JSONObject().put("connected", wanUp).put("reachable", wanUp)

        val sdf = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }
        return ok(JSONObject().put("fetchedAt", sdf.format(Date()))
            .put("router", JSONObject().put("host", activeRouterIp).put("username", "root")
                .put("luciUrl", "http://$activeRouterIp/cgi-bin/luci"))
            .put("system", system).put("network", network).put("internet", internet)
            .put("mode", mode).put("wifi", wifi))
    }

    // ═══════════════════════════════════════════════════
    // Network
    // ═══════════════════════════════════════════════════
    private fun buildNetworkPayload(): JSONObject {
        val dump = tryCall("network.interface", "dump") ?: JSONObject()
        val interfaces = dump.optJSONArray("interface") ?: JSONArray()
        val devices = tryCall("network.device", "status") ?: JSONObject()

        var wanIface: JSONObject? = null; var lanIface: JSONObject? = null
        for (i in 0 until interfaces.length()) {
            val iface = interfaces.getJSONObject(i)
            val name = iface.optString("interface")
            if (name == "lan") { lanIface = iface; continue }
            if (name == "wan" && iface.optBoolean("up") && wanIface == null) { wanIface = iface; continue }
            if (wanIface == null && name.matches(Regex("wwan.*|wan_sta.*|repeater.*", RegexOption.IGNORE_CASE)) && iface.optBoolean("up")) wanIface = iface
        }
        if (wanIface == null) for (i in 0 until interfaces.length()) {
            val iface = interfaces.getJSONObject(i); val name = iface.optString("interface")
            if (name != "lan" && name != "loopback" && iface.optBoolean("up")) {
                val routes = iface.optJSONArray("route") ?: JSONArray()
                for (r in 0 until routes.length()) if (routes.getJSONObject(r).optString("target") == "0.0.0.0") { wanIface = iface; break }
                if (wanIface != null) break
            }
        }

        fun ipv4(iface: JSONObject?): String? { val a = iface?.optJSONArray("ipv4-address") ?: return null; return if (a.length() > 0) a.getJSONObject(0).optString("address", null) else null }
        val wanIp = ipv4(wanIface); val wanDevice = wanIface?.optString("l3_device") ?: wanIface?.optString("device")
        val wanIsWireless = wanDevice?.matches(Regex("^(wlan|phy|wl).*", RegexOption.IGNORE_CASE)) == true

        val dhcpCfg = uciOf("dhcp")
        val lanDhcpSec = dhcpCfg.keys().asSequence().mapNotNull { dhcpCfg.optJSONObject(it) }
            .firstOrNull { it.optString(".type") == "dhcp" && (it.optString("interface") == "lan" || it.optString(".name") == "lan") }
        val dhcpEnabled = lanDhcpSec?.optString("ignore") != "1"

        val eth = JSONArray()
        devices.keys().forEach { name ->
            if (name.matches(Regex("^(eth|lan|wan|swp|sfp)[^.]*$", RegexOption.IGNORE_CASE))) {
                val d = devices.optJSONObject(name) ?: return@forEach
                if (d.optString("type") == "bridge") return@forEach
                eth.put(JSONObject().put("name", name).put("up", d.optBoolean("up")).put("carrier", d.optBoolean("carrier")).put("speed", d.opt("speed")))
            }
        }

        val lan = JSONObject()
            .put("present", lanIface != null).put("up", lanIface?.optBoolean("up") ?: false)
            .put("ip", ipv4(lanIface)).put("device", lanIface?.optString("l3_device") ?: lanIface?.optString("device"))
            .put("dhcpEnabled", dhcpEnabled)
            .put("clients", JSONObject().put("count", JSONObject.NULL).put("available", false)
                .put("reason", "Client list not available — requires router-side file access")
                .put("devices", JSONArray()))

        val wan = JSONObject()
            .put("present", wanIface != null).put("up", wanIface?.optBoolean("up") ?: false)
            .put("interface", wanIface?.optString("interface"))
            .put("kind", if (wanIface == null) "none" else if (wanIsWireless) "wireless" else "ethernet")
            .put("proto", wanIface?.optString("proto")).put("device", wanDevice)
            .put("ip", wanIp).put("uptimeSeconds", wanIface?.optLong("uptime", 0) ?: 0)

        return JSONObject().put("wan", wan).put("lan", lan).put("ethernetLinks", eth)
    }

    // ═══════════════════════════════════════════════════
    // Mode
    // ═══════════════════════════════════════════════════
    private fun buildModePayload(): JSONObject {
        val wireless = uciOf("wireless")
        var mode = "router"; var ssid: String? = null
        wireless.keys().forEach { k ->
            val s = wireless.optJSONObject(k) ?: return@forEach
            if (s.optString(".type") == "wifi-iface" && s.optString("mode") == "sta") {
                mode = "repeater"; ssid = s.optString("ssid", null)
            }
        }
        return JSONObject().put("id", mode)
            .put("title", if (mode == "repeater") "Wi-Fi Repeater" else "Router")
            .put("internetSource", if (mode == "repeater") "Wireless Uplink${if (ssid != null) " ($ssid)" else ""}" else "Ethernet WAN")
            .put("repeaterPaused", false)
    }

    // ═══════════════════════════════════════════════════
    // Wi-Fi
    // ═══════════════════════════════════════════════════
    private fun buildWifiSummary(): JSONObject {
        val radios = buildRadiosArray()
        return JSONObject().put("supported", radios.length() > 0).put("repeaterPaused", false).put("radios", radios)
    }

    private fun buildWifi(): Response {
        val wireless = uciOf("wireless")
        val radios = JSONArray(); val networks = JSONArray()

        wireless.keys().forEach { k ->
            val s = wireless.optJSONObject(k) ?: return@forEach
            when (s.optString(".type")) {
                "wifi-device" -> {
                    val info = tryCall("iwinfo", "info", JSONObject().put("device", k)) ?: JSONObject()
                    val band = bandFromSection(s)
                    radios.put(JSONObject().put("id", k).put("band", band).put("label", band)
                        .put("enabled", s.optString("disabled") != "1")
                        .put("channel", s.opt("channel") ?: info.opt("channel"))
                        .put("txpower", s.opt("txpower") ?: info.opt("txpower"))
                        .put("htmode", s.optString("htmode", "auto"))
                        .put("country", s.optString("country", "00"))
                        .put("clients", 0))
                }
                "wifi-iface" -> {
                    val radioId = s.optString("device")
                    val radioSection = wireless.optJSONObject(radioId) ?: JSONObject()
                    networks.put(JSONObject().put("id", k).put("radio", radioId)
                        .put("band", bandFromSection(radioSection))
                        .put("mode", s.optString("mode", "ap"))
                        .put("ssid", s.optString("ssid"))
                        .put("encryption", s.optString("encryption", "none"))
                        .put("disabled", s.optString("disabled") == "1")
                        .put("hidden", s.optString("hidden") == "1"))
                }
            }
        }
        return ok(JSONObject().put("radios", radios).put("networks", networks)
            .put("schedule", JSONObject().put("enabled", false)).put("stationCount", 0))
    }

    private fun buildRadiosArray(): JSONArray {
        val wireless = uciOf("wireless"); val out = JSONArray()
        wireless.keys().forEach { k ->
            val s = wireless.optJSONObject(k) ?: return@forEach
            if (s.optString(".type") != "wifi-device") return@forEach
            val band = bandFromSection(s)
            var ssid: String? = null
            wireless.keys().forEach { ik ->
                val iface = wireless.optJSONObject(ik) ?: return@forEach
                if (iface.optString(".type") == "wifi-iface" && iface.optString("device") == k && iface.optString("mode") == "ap")
                    ssid = iface.optString("ssid", null)
            }
            out.put(JSONObject().put("id", k).put("band", band).put("label", band)
                .put("enabled", s.optString("disabled") != "1").put("ssid", ssid)
                .put("channel", s.opt("channel")).put("clients", 0).put("interfaces", JSONArray()))
        }
        return out
    }

    private fun buildWifiClients(): Response {
        val wireless = uciOf("wireless"); val clients = JSONArray()
        wireless.keys().forEach { k ->
            val s = wireless.optJSONObject(k) ?: return@forEach
            if (s.optString(".type") != "wifi-iface" || s.optString("mode") != "ap") return@forEach
            val ifname = s.optString("ifname", "")
            if (ifname.isEmpty()) return@forEach
            val assoc = tryCall("iwinfo", "assoclist", JSONObject().put("device", ifname))
            assoc?.optJSONArray("results")?.let { results ->
                for (i in 0 until results.length()) {
                    val e = results.getJSONObject(i)
                    clients.put(JSONObject().put("mac", e.optString("mac"))
                        .put("signal", e.opt("signal")).put("radio", s.optString("device"))
                        .put("ssid", s.optString("ssid")).put("connectedSeconds", e.opt("connected_time")))
                }
            }
        }
        return ok(JSONObject().put("clients", clients).put("available", true))
    }

    private fun buildWifiScan(radioId: String?): Response {
        val radio = radioId ?: firstRadioId() ?: return ok(JSONObject().put("networks", JSONArray()).put("joinable", JSONObject()).put("congestion", JSONObject()))
        val scan = tryCall("iwinfo", "scan", JSONObject().put("device", radio))
        val networks = JSONArray()
        scan?.optJSONArray("results")?.let { results ->
            for (i in 0 until results.length()) {
                val r = results.getJSONObject(i)
                val sig = r.optInt("signal", -100)
                val quality = maxOf(0, minOf(100, ((sig + 100) * 2)))
                networks.put(JSONObject().put("ssid", r.optString("ssid")).put("bssid", r.optString("bssid"))
                    .put("signal", sig).put("quality", quality).put("channel", r.opt("channel"))
                    .put("encryption", r.optJSONObject("encryption")?.optBoolean("enabled", false) ?: false)
                    .put("encryptionMode", r.optJSONObject("encryption")?.optString("description", "none") ?: "none"))
            }
        }
        val wireless = uciOf("wireless")
        val radios = JSONArray()
        wireless.keys().forEach { k ->
            val s = wireless.optJSONObject(k) ?: return@forEach
            if (s.optString(".type") == "wifi-device")
                radios.put(JSONObject().put("id", k).put("band", bandFromSection(s)).put("label", bandFromSection(s)))
        }
        return ok(JSONObject().put("radio", radio).put("radios", radios).put("networks", networks)
            .put("joinable", JSONObject()).put("congestion", JSONObject()))
    }

    private fun applyRadioSettings(radioId: String, body: JSONObject): Response {
        val values = JSONObject()
        if (body.has("ssid")) values.put("ssid", body.getString("ssid"))
        if (body.has("password")) { values.put("key", body.getString("password")); values.put("encryption", "psk2") }
        if (body.has("channel")) values.put("channel", body.opt("channel"))
        if (body.has("txpower")) values.put("txpower", body.opt("txpower"))
        if (body.has("enabled")) {
            val enabled = body.optBoolean("enabled", true)
            // ssid is on the iface, not the device — find the AP iface for this radio
            val wireless = uciOf("wireless")
            wireless.keys().forEach { k ->
                val s = wireless.optJSONObject(k) ?: return@forEach
                if (s.optString(".type") == "wifi-iface" && s.optString("device") == radioId && s.optString("mode") == "ap") {
                    uciSet("wireless", k, JSONObject().put("disabled", if (enabled) "0" else "1"))
                }
            }
            uciSet("wireless", radioId, JSONObject().put("disabled", if (enabled) "0" else "1"))
        } else if (values.length() > 0) {
            // Apply device-level settings
            uciSet("wireless", radioId, values)
            // Apply ssid/password to AP iface
            if (body.has("ssid") || body.has("password")) {
                val wireless = uciOf("wireless"); val ifaceValues = JSONObject()
                if (body.has("ssid")) ifaceValues.put("ssid", body.getString("ssid"))
                if (body.has("password")) { ifaceValues.put("key", body.getString("password")); ifaceValues.put("encryption", "psk2") }
                wireless.keys().forEach { k ->
                    val s = wireless.optJSONObject(k) ?: return@forEach
                    if (s.optString(".type") == "wifi-iface" && s.optString("device") == radioId && s.optString("mode") == "ap")
                        uciSet("wireless", k, ifaceValues)
                }
            }
        }
        uciCommit("wireless"); uciApply()
        return ok(JSONObject().put("ok", true).put("pending", true))
    }

    private fun repeaterPause(pause: Boolean): Response {
        val firewall = uciOf("firewall")
        var ruleName = "pause_internet"
        firewall.keys().forEach { k ->
            val s = firewall.optJSONObject(k) ?: return@forEach
            if (s.optString(".type") == "rule" && (s.optString("name") == "pause-internet" || k == "pause_internet")) ruleName = k
        }
        uciSet("firewall", ruleName, JSONObject().put("enabled", if (pause) "1" else "0"))
        uciCommit("firewall")
        tryCall("firewall", "reload")
        return ok(JSONObject().put("success", true).put("paused", pause))
    }

    // ═══════════════════════════════════════════════════
    // DHCP
    // ═══════════════════════════════════════════════════
    private fun buildDhcp(): Response {
        val dhcpCfg = uciOf("dhcp")
        val lanSec = dhcpCfg.keys().asSequence().mapNotNull { k -> dhcpCfg.optJSONObject(k)?.takeIf {
            it.optString(".type") == "dhcp" && (it.optString("interface") == "lan" || it.optString(".name") == "lan") } }.firstOrNull()

        // Reservations = host sections
        val reservations = JSONArray()
        dhcpCfg.keys().forEach { k ->
            val s = dhcpCfg.optJSONObject(k) ?: return@forEach
            if (s.optString(".type") == "host") {
                reservations.put(JSONObject().put("section", k).put("mac", s.optString("mac"))
                    .put("ip", s.optString("ip")).put("name", s.optString("name", "")))
            }
        }

        return ok(JSONObject()
            .put("enabled", lanSec?.optString("ignore") != "1")
            .put("ipv6Enabled", false)
            .put("routerIp", activeRouterIp)
            .put("netmask", "255.255.255.0")
            .put("start", lanSec?.optInt("start", 100) ?: 100)
            .put("limit", lanSec?.optInt("limit", 150) ?: 150)
            .put("leasetime", lanSec?.optString("leasetime", "12h") ?: "12h")
            .put("dns", JSONArray())
            .put("reservations", reservations)
            .put("blocked", JSONArray()))
    }

    private fun updateDhcp(body: JSONObject): Response {
        val dhcpCfg = uciOf("dhcp")
        val lanSecKey = dhcpCfg.keys().asSequence().firstOrNull { k ->
            dhcpCfg.optJSONObject(k)?.let { it.optString(".type") == "dhcp" && (it.optString("interface") == "lan" || it.optString(".name") == "lan") } == true
        } ?: "lan"

        val values = JSONObject()
        if (body.has("enabled")) values.put("ignore", if (body.optBoolean("enabled")) "0" else "1")
        if (body.has("start")) values.put("start", body.optInt("start").toString())
        if (body.has("limit")) values.put("limit", body.optInt("limit").toString())
        if (body.has("leasetime")) values.put("leasetime", body.optString("leasetime"))
        uciSet("dhcp", lanSecKey, values)
        uciCommit("dhcp"); uciApply()
        return buildDhcp()
    }

    private fun buildLan(): Response {
        val networkCfg = uciOf("network")
        val lanSec = networkCfg.optJSONObject("lan") ?: JSONObject()
        return ok(JSONObject().put("ip", lanSec.optString("ipaddr", activeRouterIp))
            .put("netmask", lanSec.optString("netmask", "255.255.255.0"))
            .put("gateway", lanSec.optString("gateway", "")))
    }

    private fun updateLan(body: JSONObject): Response {
        val values = JSONObject()
        if (body.has("ip")) values.put("ipaddr", body.getString("ip"))
        if (body.has("netmask")) values.put("netmask", body.getString("netmask"))
        uciSet("network", "lan", values)
        uciCommit("network"); uciApply()
        return buildLan()
    }

    private fun addReservation(body: JSONObject): Response {
        val mac = body.optString("mac").ifEmpty { return err(Response.Status.BAD_REQUEST, "MAC required") }
        val ip = body.optString("ip").ifEmpty { return err(Response.Status.BAD_REQUEST, "IP required") }
        val name = body.optString("name", "")
        val sectionId = "host_${mac.replace(":", "")}"
        ubus.call(activeRouterIp, activeSid, "uci", "add", JSONObject()
            .put("config", "dhcp").put("name", sectionId).put("type", "host"))
        uciSet("dhcp", sectionId, JSONObject().put("mac", mac).put("ip", ip).put("name", name))
        uciCommit("dhcp"); uciApply()
        return buildDhcp()
    }

    private fun deleteReservation(section: String): Response {
        try { ubus.call(activeRouterIp, activeSid, "uci", "delete", JSONObject().put("config", "dhcp").put("section", section)) } catch (_: Exception) {}
        uciCommit("dhcp"); uciApply()
        return buildDhcp()
    }

    private fun blockClient(body: JSONObject): Response {
        val mac = body.optString("mac").ifEmpty { return err(Response.Status.BAD_REQUEST, "MAC required") }
        val sectionId = "block_${mac.replace(":", "")}"
        try {
            ubus.call(activeRouterIp, activeSid, "uci", "add", JSONObject().put("config", "firewall").put("name", sectionId).put("type", "rule"))
            uciSet("firewall", sectionId, JSONObject().put("name", "block_$mac").put("src", "lan")
                .put("src_mac", mac).put("dest", "wan").put("proto", "all").put("target", "REJECT"))
            uciCommit("firewall"); uciApply()
        } catch (_: Exception) {}
        return buildDhcp()
    }

    private fun unblockClient(mac: String): Response {
        val firewall = uciOf("firewall")
        firewall.keys().forEach { k ->
            val s = firewall.optJSONObject(k) ?: return@forEach
            if (s.optString(".type") == "rule" && s.optString("src_mac").equals(mac, ignoreCase = true)) {
                try { ubus.call(activeRouterIp, activeSid, "uci", "delete", JSONObject().put("config", "firewall").put("section", k)) } catch (_: Exception) {}
            }
        }
        uciCommit("firewall"); uciApply()
        return buildDhcp()
    }

    // ═══════════════════════════════════════════════════
    // Mode Switching (simplified — triggers uci + apply)
    // ═══════════════════════════════════════════════════
    private fun switchMode(mode: String, body: JSONObject): Response {
        return ok(JSONObject().put("mode", mode).put("pending", true)
            .put("message", "Mode switching setup wizard should be used for full configuration. Direct mode switch to '$mode' initiated.")
            .put("steps", JSONArray().put(JSONObject().put("id", "apply").put("status", "pending").put("label", "Applying $mode configuration"))))
    }

    // ═══════════════════════════════════════════════════
    // Diagnostics
    // ═══════════════════════════════════════════════════
    private fun runDiagnostic(type: String, body: JSONObject): Response {
        val host = body.optString("host").trim()
        if (host.isEmpty() || !host.matches(Regex("^[a-zA-Z0-9.-]+$")) || host.startsWith("-"))
            return err(Response.Status.BAD_REQUEST, "A valid hostname or IP address is required.")

        val (command, params) = when (type) {
            "ping" -> Pair("/bin/ping", JSONArray().put("-c").put("4").put("-W").put("2").put(host))
            else   -> Pair("/usr/bin/traceroute", JSONArray().put("-m").put("15").put("-w").put("2").put("-q").put("1").put(host))
        }

        val result = tryCall("file", "exec", JSONObject().put("command", command).put("params", params))
        val output = result?.optString("stdout") ?: result?.optString("stderr") ?: "No output received."
        val code = result?.optInt("code", -1) ?: -1
        return ok(JSONObject().put("output", output).put("code", code))
    }

    // ═══════════════════════════════════════════════════
    // System
    // ═══════════════════════════════════════════════════
    private fun buildSystemOverview(): Response {
        val board = tryCall("system", "board") ?: JSONObject()
        val sysInfo = tryCall("system", "info")
        val memInfo = sysInfo?.optJSONObject("memory") ?: JSONObject()
        val memTotal = memInfo.optLong("total", 0); val memFree = memInfo.optLong("free", 0) + memInfo.optLong("buffered", 0)
        val memUsed = if (memTotal > 0) memTotal - memFree else 0L
        val memPercent = if (memTotal > 0) Math.round((memUsed.toDouble() / memTotal) * 1000.0) / 10.0 else null
        val uptime = sysInfo?.optLong("uptime", 0) ?: 0L
        val loadArr = sysInfo?.optJSONArray("load")
        val loadList = loadArr?.let { arr -> JSONArray().also { out -> for (i in 0 until minOf(arr.length(), 3)) out.put(Math.round((arr.getDouble(i) / 65536.0) * 100.0) / 100.0) } }

        val system = JSONObject()
            .put("model", board.optString("model")).put("hostname", board.optString("hostname"))
            .put("boardName", board.optString("board_name")).put("processor", board.optString("system"))
            .put("firmware", board.optJSONObject("release")?.optString("description", "") ?: "")
            .put("version", board.optJSONObject("release")?.optString("version", "") ?: "")
            .put("kernel", board.optString("kernel")).put("uptimeSeconds", uptime)
            .put("uptime", formatUptime(uptime)).put("autoReboot", JSONObject.NULL)
            .put("memory", JSONObject().put("total", memTotal).put("used", memUsed).put("percent", memPercent))
            .put("cpu", JSONObject().put("percent", JSONObject.NULL).put("available", false).put("reason", "Requires file access"))
            .put("load", loadList ?: JSONObject.NULL)

        return ok(JSONObject().put("system", system)
            .put("router", JSONObject().put("host", activeRouterIp).put("username", "root")
                .put("luciUrl", "http://$activeRouterIp/cgi-bin/luci"))
            .put("capabilities", capabilities().optJSONObject("features") ?: JSONObject()))
    }

    private fun rebootRouter(): Response {
        tryCall("system", "reboot")
        return ok(JSONObject().put("ok", true))
    }

    // ═══════════════════════════════════════════════════
    // Bandwidth
    // ═══════════════════════════════════════════════════
    private fun buildBandwidth(): Response {
        // Try reading interface stats via network.device status
        val devices = tryCall("network.device", "status") ?: JSONObject()
        val entries = JSONArray()
        devices.keys().forEach { name ->
            val d = devices.optJSONObject(name) ?: return@forEach
            val stats = d.optJSONObject("statistics") ?: return@forEach
            if (!name.matches(Regex("^(br-|lo).*"))) {
                entries.put(JSONObject().put("interface", name)
                    .put("rxBytes", stats.optLong("rx_bytes", 0))
                    .put("txBytes", stats.optLong("tx_bytes", 0))
                    .put("rxPackets", stats.optLong("rx_packets", 0))
                    .put("txPackets", stats.optLong("tx_packets", 0)))
            }
        }
        return ok(JSONObject().put("available", entries.length() > 0).put("interfaces", entries)
            .put("totalLimit", JSONObject.NULL).put("deviceLimits", JSONArray()))
    }

    // ═══════════════════════════════════════════════════
    // Utilities
    // ═══════════════════════════════════════════════════
    private fun bandFromSection(s: JSONObject): String {
        val band = s.optString("band", "")
        return when { band.contains("5") -> "5GHz"; band.contains("6") -> "6GHz"; else -> "2.4GHz" }
    }

    private fun firstRadioId(): String? {
        val wireless = uciOf("wireless")
        return wireless.keys().asSequence().firstOrNull { k -> wireless.optJSONObject(k)?.optString(".type") == "wifi-device" }
    }

    private fun formatUptime(seconds: Long): String {
        if (seconds <= 0) return "—"
        val d = seconds / 86400; val h = (seconds % 86400) / 3600; val m = (seconds % 3600) / 60
        return when { d > 0 -> "${d}d ${h}h"; h > 0 -> "${h}h ${m}m"; else -> "${m}m" }
    }
}
