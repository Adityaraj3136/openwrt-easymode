package com.example.easymode

import android.content.Context
import fi.iki.elonen.NanoHTTPD
import java.io.IOException
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import org.json.JSONArray
import org.json.JSONObject

/**
 * Local HTTP server that serves the EasyMode frontend and bridges all /api/ calls
 * to the OpenWrt router's ubus JSON-RPC endpoint natively in Kotlin.
 *
 * Persistence: router IP and session ID are stored in SharedPreferences so they
 * survive the Android process being killed and restarted.
 */
class EasyModeServer(private val context: Context, port: Int) : NanoHTTPD(port) {

    private val ubus = UbusClient()
    private val prefs = context.getSharedPreferences("easymode", Context.MODE_PRIVATE)

    // Persisted across process restarts
    private var activeRouterIp: String
        get() = prefs.getString("routerIp", "192.168.1.1") ?: "192.168.1.1"
        set(v) { prefs.edit().putString("routerIp", v).apply() }

    private var activeSid: String
        get() = prefs.getString("sessionId", "") ?: ""
        set(v) { prefs.edit().putString("sessionId", v).apply() }

    // Bandwidth delta: two consecutive samples to compute bytes/sec
    private data class BwSample(val ts: Long, val rx: Long, val tx: Long, val iface: String)
    private var lastBwSample: BwSample? = null

    // ── Called by MainActivity when Wi-Fi network changes ────
    fun onNetworkChanged() {
        val newGateway = getGatewayIp()
        if (newGateway != "192.168.1.1" && newGateway != activeRouterIp) {
            // New network detected — clear session so user re-authenticates
            activeSid = ""
            activeRouterIp = newGateway
        }
    }

    // ── Gateway IP detection ──────────────────────────────────
    private fun getGatewayIp(): String {
        return try {
            val cm = context.applicationContext
                .getSystemService(Context.CONNECTIVITY_SERVICE) as android.net.ConnectivityManager
            val network = cm.activeNetwork ?: return tryDhcpFallback()
            val props = cm.getLinkProperties(network) ?: return tryDhcpFallback()
            // Find the default IPv4 route's gateway
            val gw = props.routes
                .firstOrNull { it.isDefaultRoute && it.gateway?.hostAddress?.contains('.') == true }
                ?.gateway?.hostAddress
            if (!gw.isNullOrEmpty()) gw else tryDhcpFallback()
        } catch (_: Exception) { tryDhcpFallback() }
    }

    @Suppress("DEPRECATION")
    private fun tryDhcpFallback(): String {
        return try {
            val wm = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as android.net.wifi.WifiManager
            val g = wm.dhcpInfo.gateway
            if (g != 0) {
                val b = byteArrayOf((g and 0xFF).toByte(), ((g shr 8) and 0xFF).toByte(),
                    ((g shr 16) and 0xFF).toByte(), ((g shr 24) and 0xFF).toByte())
                java.net.InetAddress.getByAddress(b).hostAddress ?: "192.168.1.1"
            } else "192.168.1.1"
        } catch (_: Exception) { "192.168.1.1" }
    }

    // ── Response helpers ──────────────────────────────────────
    private fun ok(obj: JSONObject) = newFixedLengthResponse(Response.Status.OK, "application/json", obj.toString())
    private fun ok(s: String) = newFixedLengthResponse(Response.Status.OK, "application/json", s)
    private fun err(status: Response.Status, msg: String): Response =
        newFixedLengthResponse(status, "application/json",
            JSONObject().put("error", JSONObject().put("code", "ERROR").put("message", msg)).toString())

    // ── Ubus helpers ──────────────────────────────────────────
    private fun tryCall(obj: String, method: String, args: JSONObject? = null): JSONObject? =
        try { ubus.call(activeRouterIp, activeSid, obj, method, args) } catch (_: Exception) { null }

    private fun uciOf(config: String): JSONObject =
        try { ubus.call(activeRouterIp, activeSid, "uci", "get",
            JSONObject().put("config", config)).optJSONObject("values") ?: JSONObject() }
        catch (_: Exception) { JSONObject() }

    private fun uciSet(config: String, section: String, values: JSONObject) {
        try { ubus.call(activeRouterIp, activeSid, "uci", "set",
            JSONObject().put("config", config).put("section", section).put("values", values))
        } catch (_: Exception) {}
    }

    private fun uciDelete(config: String, section: String) {
        try { ubus.call(activeRouterIp, activeSid, "uci", "delete",
            JSONObject().put("config", config).put("section", section))
        } catch (_: Exception) {}
    }

    private fun uciAdd(config: String, name: String, type: String): String {
        return try {
            val r = ubus.call(activeRouterIp, activeSid, "uci", "add",
                JSONObject().put("config", config).put("name", name).put("type", type))
            r.optString("section", name)
        } catch (_: Exception) { name }
    }

    private fun uciCommit(vararg configs: String) {
        configs.forEach { cfg ->
            try { ubus.call(activeRouterIp, activeSid, "uci", "commit", JSONObject().put("config", cfg)) }
            catch (_: Exception) {}
        }
    }

    private fun uciApply() {
        try { ubus.call(activeRouterIp, activeSid, "uci", "apply",
            JSONObject().put("timeout", 10).put("rollback", false)) }
        catch (_: Exception) {}
    }

    private fun capabilities() = JSONObject().put("features", JSONObject()
        .put("wirelessControl", true).put("wifiSchedule", false)
        .put("fileRead", false).put("cpuUsage", false))

    // ── Static file serving ───────────────────────────────────
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

    // ── API dispatcher ────────────────────────────────────────
    private fun handleApi(session: IHTTPSession): Response {
        val uri = session.uri
        val method = session.method
        val bodyMap = HashMap<String, String>()
        if (method == Method.POST || method == Method.PUT || method == Method.DELETE)
            try { session.parseBody(bodyMap) } catch (_: Exception) {}
        val body = runCatching { JSONObject(bodyMap["postData"] ?: "{}") }.getOrDefault(JSONObject())

        // Check session via cookie OR via stored SID (for session restoration)
        val cookieSid = session.cookies.read("sysauth_http") ?: ""
        val storedSid = activeSid
        val isPublic = uri == "/api/auth/config" || uri == "/api/auth/login"

        // Session is valid if cookie matches stored SID and SID is not empty
        val sessionValid = storedSid.isNotEmpty() && (cookieSid == storedSid || cookieSid.isEmpty())
        if (!isPublic && !sessionValid)
            return err(Response.Status.UNAUTHORIZED, "Session expired. Please log in again.")

        return try { dispatch(session, uri, method, body) }
        catch (e: Exception) { err(Response.Status.INTERNAL_ERROR, e.message ?: "Internal error") }
    }

    @Suppress("CyclomaticComplexMethod")
    private fun dispatch(session: IHTTPSession, uri: String, method: Method, body: JSONObject): Response {
        // ── Auth ────────────────────────────────────────────────
        if (uri == "/api/auth/config") return ok(JSONObject()
            .put("defaultRouterHost", getGatewayIp()).put("demoAvailable", false))

        if (uri == "/api/auth/login") {
            val host = body.optString("host", getGatewayIp()).trim()
            activeRouterIp = host
            val result = ubus.call(host, "00000000000000000000000000000000", "session", "login",
                JSONObject().put("username", body.optString("username", "root"))
                    .put("password", body.optString("password", "")))
            val sid = result.getString("ubus_rpc_session")
            activeSid = sid
            val r = ok(JSONObject().put("router", JSONObject().put("host", host))
                .put("capabilities", capabilities())
                .put("username", body.optString("username", "root")).put("host", host))
            r.addHeader("Set-Cookie", "sysauth_http=$sid; Path=/; HttpOnly")
            return r
        }

        if (uri == "/api/auth/session") {
            // Restore session — validate stored SID against router
            val storedSid = activeSid
            if (storedSid.isEmpty()) return err(Response.Status.UNAUTHORIZED, "No session")
            // Quick ping to verify session still alive
            val check = tryCall("session", "access")
            if (check == null) {
                activeSid = ""
                return err(Response.Status.UNAUTHORIZED, "Session expired on router")
            }
            val r = ok(JSONObject().put("host", activeRouterIp).put("username", "root")
                .put("capabilities", capabilities()))
            r.addHeader("Set-Cookie", "sysauth_http=$storedSid; Path=/; HttpOnly")
            return r
        }

        if (uri == "/api/auth/logout") {
            try { ubus.call(activeRouterIp, activeSid, "session", "destroy") } catch (_: Exception) {}
            activeSid = ""
            val r = ok("{}"); r.addHeader("Set-Cookie", "sysauth_http=; Path=/; Max-Age=0"); return r
        }

        // ── Dashboard ────────────────────────────────────────────
        if (uri == "/api/status") return buildDashboard()
        if (uri == "/api/status/network") return ok(buildNetworkPayload())
        if (uri == "/api/status/mode") return ok(buildModePayload())

        // ── Wi-Fi ────────────────────────────────────────────────
        if (uri == "/api/wifi") return buildWifi()
        if (uri == "/api/wifi/clients") return buildWifiClients()
        if (uri.startsWith("/api/wifi/scan")) return buildWifiScan(session.parms["radio"])
        if (uri.startsWith("/api/wifi/radio/") && method == Method.POST) {
            return applyRadioSettings(uri.removePrefix("/api/wifi/radio/"), body)
        }
        if (uri.startsWith("/api/wifi/optimize/") && method == Method.POST) {
            return ok(JSONObject().put("ok", true).put("optimized", false)
                .put("reason", "Channel optimization not available in Android app — use LuCI."))
        }
        if (uri == "/api/wifi/repeater/disconnect" && method == Method.POST) return repeaterPause(true)
        if (uri == "/api/wifi/repeater/connect" && method == Method.POST) return repeaterPause(false)
        if (uri == "/api/wifi/guest" && method == Method.GET) return ok(JSONObject().put("enabled", false))
        if (uri == "/api/wifi/guest" && method == Method.POST) return ok(JSONObject().put("ok", true))

        // ── DHCP ─────────────────────────────────────────────────
        if (uri == "/api/dhcp" && method == Method.GET) return buildDhcp()
        if (uri == "/api/dhcp" && method == Method.POST) return updateDhcp(body)
        if (uri == "/api/lan" && method == Method.GET) return buildLan()
        if (uri == "/api/lan" && method == Method.POST) return updateLan(body)
        if (uri == "/api/dhcp/reservations" && method == Method.POST) return addReservation(body)
        if (uri.startsWith("/api/dhcp/reservations/") && method == Method.DELETE)
            return deleteReservation(uri.removePrefix("/api/dhcp/reservations/"))
        if (uri == "/api/dhcp/blocked" && method == Method.POST) return blockClient(body)
        if (uri.startsWith("/api/dhcp/blocked/") && method == Method.DELETE)
            return unblockClient(uri.removePrefix("/api/dhcp/blocked/"))

        // ── Mode switching ───────────────────────────────────────
        if (uri == "/api/mode") return ok(buildModeOverview())
        if (uri == "/api/mode/router" && method == Method.POST) return switchToRouter(body)
        if (uri == "/api/mode/ap" && method == Method.POST) return switchToAP(body)
        if (uri == "/api/mode/repeater" && method == Method.POST) return switchToRepeater(body)
        if (uri == "/api/mode/hotspot" && method == Method.POST)
            return ok(JSONObject().put("ok", false).put("message", "Hotspot mode not supported on this router"))

        // ── Diagnostics ──────────────────────────────────────────
        if (uri == "/api/diagnostics/ping" && method == Method.POST) return runDiagnostic("ping", body)
        if (uri == "/api/diagnostics/traceroute" && method == Method.POST) return runDiagnostic("traceroute", body)

        // ── System ───────────────────────────────────────────────
        if (uri == "/api/system/overview") return buildSystemOverview()
        if (uri == "/api/system/reboot" && method == Method.POST) return rebootRouter()
        if (uri == "/api/system/autoreboot" && method == Method.POST) return ok(JSONObject().put("ok", true))
        if (uri == "/api/system/backup") return ok(JSONObject().put("ok", false).put("message", "Backup not supported in Android app"))
        if (uri == "/api/system/restore" && method == Method.POST) return ok(JSONObject().put("ok", false).put("message", "Restore not supported in Android app"))

        // ── Bandwidth ─────────────────────────────────────────────
        if (uri == "/api/bandwidth") return buildBandwidth()
        if (uri == "/api/bandwidth/limits" && method == Method.POST) return ok(JSONObject().put("ok", true))
        if (uri.startsWith("/api/bandwidth/device/") && method == Method.POST) return ok(JSONObject().put("ok", true))

        return err(Response.Status.NOT_FOUND, "Endpoint $uri not implemented")
    }

    // ═══════════════════════════════════════════════════════════
    // Dashboard
    // ═══════════════════════════════════════════════════════════
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

    // ═══════════════════════════════════════════════════════════
    // Network
    // ═══════════════════════════════════════════════════════════
    private fun buildNetworkPayload(): JSONObject {
        val dump = tryCall("network.interface", "dump") ?: JSONObject()
        val interfaces = dump.optJSONArray("interface") ?: JSONArray()
        val devices = tryCall("network.device", "status") ?: JSONObject()

        var wanIface: JSONObject? = null; var lanIface: JSONObject? = null
        for (i in 0 until interfaces.length()) {
            val iface = interfaces.getJSONObject(i); val name = iface.optString("interface")
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
        val wanDevice = wanIface?.optString("l3_device") ?: wanIface?.optString("device")
        val wanIsWireless = wanDevice?.matches(Regex("^(wlan|phy|wl).*", RegexOption.IGNORE_CASE)) == true
        val dhcpCfg = uciOf("dhcp")
        val lanDhcpSec = dhcpCfg.keys().asSequence().mapNotNull { k -> dhcpCfg.optJSONObject(k)?.takeIf {
            it.optString(".type") == "dhcp" && (it.optString("interface") == "lan" || it.optString(".name") == "lan") } }.firstOrNull()
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
                .put("reason", "Client list requires router-side file access").put("devices", JSONArray()))
        val wan = JSONObject()
            .put("present", wanIface != null).put("up", wanIface?.optBoolean("up") ?: false)
            .put("interface", wanIface?.optString("interface"))
            .put("kind", if (wanIface == null) "none" else if (wanIsWireless) "wireless" else "ethernet")
            .put("proto", wanIface?.optString("proto")).put("device", wanDevice)
            .put("ip", ipv4(wanIface)).put("uptimeSeconds", wanIface?.optLong("uptime", 0) ?: 0)
        return JSONObject().put("wan", wan).put("lan", lan).put("ethernetLinks", eth)
    }

    // ═══════════════════════════════════════════════════════════
    // Mode
    // ═══════════════════════════════════════════════════════════
    // Returns the full mode overview object the Mode page (api.modeOverview) expects
    private fun buildModeOverview(): JSONObject {
        val wireless = uciOf("wireless")
        var modeId = "router"
        var uplinkSsid: String? = null

        wireless.keys().forEach { k ->
            val s = wireless.optJSONObject(k) ?: return@forEach
            if ((s.optString(".type") == "wifi-iface") && s.optString("mode") == "sta") {
                modeId = "repeater"; uplinkSsid = s.optString("ssid", null)
            }
        }

        // Check if AP mode: LAN interface has proto=dhcp (gets IP from upstream)
        val network = uciOf("network")
        val lanSec = network.optJSONObject("lan") ?: JSONObject()
        if (modeId != "repeater" && lanSec.optString("proto") == "dhcp") modeId = "ap"

        val internetSource = when (modeId) {
            "repeater" -> "Wireless Uplink${if (uplinkSsid != null) " ($uplinkSsid)" else ""}"
            "ap"       -> "Ethernet (from upstream router)"
            else       -> "Ethernet WAN"
        }

        // Build radios list
        val radioArr = JSONArray()
        wireless.keys().forEach { k ->
            val s = wireless.optJSONObject(k) ?: return@forEach
            if (s.optString(".type") != "wifi-device") return@forEach
            val band = bandFromSection(s)
            radioArr.put(JSONObject().put("id", k).put("band", band)
                .put("label", if (band == "5GHz") "5 GHz" else "2.4 GHz")
                .put("enabled", s.optString("disabled") != "1"))
        }

        // Current mode object
        val currentObj = JSONObject()
            .put("id", modeId)
            .put("title", when (modeId) { "repeater" -> "Wi-Fi Repeater"; "ap" -> "Access Point"; else -> "Router" })
            .put("internetSource", internetSource)
            .put("repeaterPaused", false)
        if (uplinkSsid != null) {
            currentObj.put("uplink", JSONObject().put("kind", "wireless").put("ssid", uplinkSsid).put("paused", false))
        }

        // First AP iface defaults
        var defaultSsid: String? = null; var defaultEncryption = "psk2"
        wireless.keys().forEach { k ->
            val s = wireless.optJSONObject(k) ?: return@forEach
            if (s.optString(".type") == "wifi-iface" && s.optString("mode", "ap") == "ap" && defaultSsid == null) {
                defaultSsid = s.optString("ssid", null)
                defaultEncryption = s.optString("encryption", "psk2")
            }
        }

        return JSONObject()
            .put("current", currentObj)
            .put("busy", false)
            .put("defaults", JSONObject()
                .put("lanIp", lanSec.optString("ipaddr", activeRouterIp))
                .put("lanNetmask", lanSec.optString("netmask", "255.255.255.0"))
                .put("wifiSsid", defaultSsid)
                .put("wifiKey", null)
                .put("wifiEncryption", defaultEncryption)
                .put("hasWifi", radioArr.length() > 0))
            .put("preflight", JSONObject()
                .put("router", JSONObject().put("ok", true))
                .put("ap", JSONObject().put("suggestedUplink", "wan")))
            .put("available", JSONObject()
                .put("router", true).put("ap", true)
                .put("repeater", radioArr.length() > 0)
                .put("hotspot", false))
            .put("wireless", JSONObject()
                .put("radios", radioArr)
                .put("singleRadio", radioArr.length() == 1))
    }

    // Simple current-mode-only object for /api/status/mode (dashboard strip)
    private fun buildModePayload(): JSONObject {
        val overview = buildModeOverview()
        return overview.optJSONObject("current") ?: JSONObject().put("id", "router")
            .put("title", "Router").put("internetSource", "Ethernet WAN").put("repeaterPaused", false)
    }


    // ═══════════════════════════════════════════════════════════
    // Wi-Fi
    // ═══════════════════════════════════════════════════════════
    private fun buildWifiSummary(): JSONObject {
        val radios = buildRadiosArray(false)
        return JSONObject().put("supported", radios.length() > 0).put("repeaterPaused", false).put("radios", radios)
    }

    private fun buildWifi(): Response {
        val radios = buildRadiosArray(true)
        return ok(JSONObject().put("radios", radios).put("supported", radios.length() > 0))
    }

    private fun buildRadiosArray(detailed: Boolean): JSONArray {
        val wireless = uciOf("wireless")
        val netWireless = tryCall("network.wireless", "status") ?: JSONObject()
        val out = JSONArray()

        wireless.keys().forEach { k ->
            val s = wireless.optJSONObject(k) ?: return@forEach
            val type = s.optString(".type").ifEmpty {
                if (k.matches(Regex("radio\\d+"))) "wifi-device" else "wifi-iface"
            }
            if (type != "wifi-device") return@forEach

            val interfaces = JSONArray()
            var primarySsid: String? = null
            var clients = 0

            // Add active interfaces from network.wireless first (they have live runtime data)
            val netRadio = netWireless.optJSONObject(k)
            val netInterfaces = netRadio?.optJSONArray("interfaces") ?: JSONArray()
            
            for (i in 0 until netInterfaces.length()) {
                val netIface = netInterfaces.optJSONObject(i) ?: continue
                val cfg = netIface.optJSONObject("config") ?: JSONObject()
                val mode = cfg.optString("mode", "ap")
                val ssid = cfg.optString("ssid", null)
                val ifname = netIface.optString("ifname", "")
                
                if (mode == "ap" && primarySsid == null) primarySsid = ssid
                
                if (detailed && ifname.isNotEmpty()) {
                    val assoc = tryCall("iwinfo", "assoclist", JSONObject().put("device", ifname))
                    clients += assoc?.optJSONArray("results")?.length() ?: 0
                }
                
                interfaces.put(JSONObject()
                    .put("section", cfg.optString(".name", null))
                    .put("ifname", ifname)
                    .put("mode", mode)
                    .put("ssid", ssid)
                    .put("network", cfg.opt("network")?.let { if (it is JSONArray) it else JSONArray().put(it) } ?: JSONArray())
                    .put("encryption", cfg.optString("encryption", "none"))
                    .put("disabled", cfg.optString("disabled", "0") == "1")
                    .put("hidden", cfg.optString("hidden", "0") == "1")
                )
            }

            val band = bandFromSection(s)
            val info = if (detailed) tryCall("iwinfo", "info", JSONObject().put("device", k)) ?: JSONObject() else null

            val radioObj = JSONObject()
                .put("id", k)
                .put("band", band)
                .put("label", if (band == "5GHz") "5 GHz" else "2.4 GHz")
                .put("enabled", s.optString("disabled") != "1")
                .put("ssid", primarySsid)
                .put("channel", s.opt("channel") ?: info?.opt("channel"))
                .put("clients", clients)
                .put("interfaces", interfaces)

            if (detailed) {
                radioObj.put("txpower", s.opt("txpower") ?: info?.opt("txpower"))
                radioObj.put("htmode", s.optString("htmode", "auto"))
                radioObj.put("country", s.optString("country", "00"))
            }

            out.put(radioObj)
        }
        return out
    }


    private fun buildWifiClients(): Response {
        val clients = JSONArray()
        // Use network.wireless ubus which gives real runtime interface names
        val netWireless = tryCall("network.wireless", "status") ?: JSONObject()
        netWireless.keys().forEach { radioId ->
            val radioObj = netWireless.optJSONObject(radioId) ?: return@forEach
            val interfaces = radioObj.optJSONArray("interfaces") ?: return@forEach
            for (i in 0 until interfaces.length()) {
                val iface = interfaces.optJSONObject(i) ?: continue
                val ifname = iface.optString("ifname", "")
                val config = iface.optJSONObject("config") ?: JSONObject()
                if (config.optString("mode", "ap") != "ap" || ifname.isEmpty()) continue
                val assoc = tryCall("iwinfo", "assoclist", JSONObject().put("device", ifname))
                assoc?.optJSONArray("results")?.let { results ->
                    for (j in 0 until results.length()) {
                        val e = results.getJSONObject(j)
                        clients.put(JSONObject().put("mac", e.optString("mac")).put("signal", e.opt("signal"))
                            .put("radio", radioId).put("ssid", config.optString("ssid", ""))
                            .put("connectedSeconds", e.opt("connected_time")))
                    }
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
                val r = results.getJSONObject(i); val sig = r.optInt("signal", -100)
                networks.put(JSONObject().put("ssid", r.optString("ssid")).put("bssid", r.optString("bssid"))
                    .put("signal", sig).put("quality", maxOf(0, minOf(100, (sig + 100) * 2)))
                    .put("channel", r.opt("channel"))
                    .put("encryption", r.optJSONObject("encryption")?.optBoolean("enabled", false) ?: false)
                    .put("encryptionMode", r.optJSONObject("encryption")?.optString("description", "none") ?: "none"))
            }
        }
        val wireless = uciOf("wireless"); val radios = JSONArray()
        wireless.keys().forEach { k ->
            val s = wireless.optJSONObject(k) ?: return@forEach
            if (s.optString(".type") == "wifi-device")
                radios.put(JSONObject().put("id", k).put("band", bandFromSection(s)).put("label", bandFromSection(s)))
        }
        return ok(JSONObject().put("radio", radio).put("radios", radios).put("networks", networks)
            .put("joinable", JSONObject()).put("congestion", JSONObject()))
    }

    private fun applyRadioSettings(radioId: String, body: JSONObject): Response {
        val wireless = uciOf("wireless")
        // Update device-level settings
        val deviceValues = JSONObject()
        if (body.has("channel")) deviceValues.put("channel", body.opt("channel"))
        if (body.has("txpower")) deviceValues.put("txpower", body.opt("txpower"))
        if (body.has("htmode")) deviceValues.put("htmode", body.optString("htmode"))
        if (body.has("enabled")) deviceValues.put("disabled", if (body.optBoolean("enabled")) "0" else "1")
        if (deviceValues.length() > 0) uciSet("wireless", radioId, deviceValues)

        // Update AP interface: ssid, password, enabled
        wireless.keys().forEach { k ->
            val s = wireless.optJSONObject(k) ?: return@forEach
            if (s.optString(".type") != "wifi-iface" || s.optString("device") != radioId || s.optString("mode") != "ap") return@forEach
            val ifaceValues = JSONObject()
            if (body.has("ssid")) ifaceValues.put("ssid", body.getString("ssid"))
            if (body.has("password") && body.optString("password").isNotEmpty()) {
                ifaceValues.put("key", body.getString("password")); ifaceValues.put("encryption", "psk2")
            }
            if (body.has("enabled")) ifaceValues.put("disabled", if (body.optBoolean("enabled")) "0" else "1")
            if (ifaceValues.length() > 0) uciSet("wireless", k, ifaceValues)
        }
        uciCommit("wireless"); uciApply()
        return ok(JSONObject().put("ok", true).put("pending", true))
    }

    private fun repeaterPause(pause: Boolean): Response {
        val firewall = uciOf("firewall"); var ruleName = "pause_internet"
        firewall.keys().forEach { k ->
            val s = firewall.optJSONObject(k) ?: return@forEach
            if (s.optString(".type") == "rule" && (s.optString("name") == "pause-internet" || k == "pause_internet")) ruleName = k
        }
        uciSet("firewall", ruleName, JSONObject().put("enabled", if (pause) "1" else "0"))
        uciCommit("firewall"); tryCall("firewall", "reload")
        return ok(JSONObject().put("success", true).put("paused", pause))
    }

    // ═══════════════════════════════════════════════════════════
    // DHCP
    // ═══════════════════════════════════════════════════════════
    private fun buildDhcp(): Response {
        val dhcpCfg = uciOf("dhcp")
        val lanSec = dhcpCfg.keys().asSequence().mapNotNull { k -> dhcpCfg.optJSONObject(k)?.takeIf {
            it.optString(".type") == "dhcp" && (it.optString("interface") == "lan" || it.optString(".name") == "lan") } }.firstOrNull()
        val reservations = JSONArray()
        dhcpCfg.keys().forEach { k ->
            val s = dhcpCfg.optJSONObject(k) ?: return@forEach
            if (s.optString(".type") == "host")
                reservations.put(JSONObject().put("section", k).put("mac", s.optString("mac"))
                    .put("ip", s.optString("ip")).put("name", s.optString("name", "")))
        }
        // DNS: UCI stores as a list — may be JSONArray or space-separated string
        val dnsArr = JSONArray()
        lanSec?.let { sec ->
            when (val raw = sec.opt("dhcp_option") ?: sec.opt("dns")) {
                is JSONArray -> for (i in 0 until raw.length()) {
                    val entry = raw.optString(i)
                    // dhcp_option format: "6,1.1.1.1,8.8.8.8"
                    if (entry.startsWith("6,")) entry.removePrefix("6,").split(",").forEach { dnsArr.put(it.trim()) }
                    else if (entry.isNotEmpty()) dnsArr.put(entry.trim())
                }
                is String -> if (raw.isNotEmpty()) raw.split(" ", ",").forEach { if (it.isNotBlank()) dnsArr.put(it.trim()) }
                else -> Unit
            }
        }
        return ok(JSONObject().put("enabled", lanSec?.optString("ignore") != "1")
            .put("ipv6Enabled", false).put("routerIp", activeRouterIp).put("netmask", "255.255.255.0")
            .put("start", lanSec?.optInt("start", 100) ?: 100).put("limit", lanSec?.optInt("limit", 150) ?: 150)
            .put("leasetime", lanSec?.optString("leasetime", "12h") ?: "12h")
            .put("dns", dnsArr).put("reservations", reservations).put("blocked", JSONArray()))
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
        if (body.has("dns")) {
            val dnsInput = body.optJSONArray("dns")
            if (dnsInput != null && dnsInput.length() > 0) {
                val servers = (0 until dnsInput.length()).map { dnsInput.optString(it) }.filter { it.isNotBlank() }
                // Store as dhcp_option "6,<dns1>,<dns2>"
                values.put("dhcp_option", JSONArray().put("6,${servers.joinToString(",")}"))
            } else {
                values.put("dhcp_option", JSONArray()) // clear DNS
            }
        }
        uciSet("dhcp", lanSecKey, values); uciCommit("dhcp"); uciApply()
        return buildDhcp()
    }


    private fun buildLan(): Response {
        val networkCfg = uciOf("network"); val lanSec = networkCfg.optJSONObject("lan") ?: JSONObject()
        return ok(JSONObject().put("ip", lanSec.optString("ipaddr", activeRouterIp))
            .put("netmask", lanSec.optString("netmask", "255.255.255.0"))
            .put("gateway", lanSec.optString("gateway", "")))
    }

    private fun updateLan(body: JSONObject): Response {
        val values = JSONObject()
        if (body.has("ip")) values.put("ipaddr", body.getString("ip"))
        if (body.has("netmask")) values.put("netmask", body.getString("netmask"))
        uciSet("network", "lan", values); uciCommit("network"); uciApply()
        return buildLan()
    }

    private fun addReservation(body: JSONObject): Response {
        val mac = body.optString("mac").ifEmpty { return err(Response.Status.BAD_REQUEST, "MAC required") }
        val ip = body.optString("ip").ifEmpty { return err(Response.Status.BAD_REQUEST, "IP required") }
        val sectionId = "host_${mac.replace(":", "")}"
        uciAdd("dhcp", sectionId, "host")
        uciSet("dhcp", sectionId, JSONObject().put("mac", mac).put("ip", ip).put("name", body.optString("name", "")))
        uciCommit("dhcp"); uciApply(); return buildDhcp()
    }

    private fun deleteReservation(section: String): Response {
        uciDelete("dhcp", section); uciCommit("dhcp"); uciApply(); return buildDhcp()
    }

    private fun blockClient(body: JSONObject): Response {
        val mac = body.optString("mac").ifEmpty { return err(Response.Status.BAD_REQUEST, "MAC required") }
        val sectionId = "block_${mac.replace(":", "")}"
        try {
            uciAdd("firewall", sectionId, "rule")
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
            if (s.optString(".type") == "rule" && s.optString("src_mac").equals(mac, ignoreCase = true))
                uciDelete("firewall", k)
        }
        uciCommit("firewall"); uciApply(); return buildDhcp()
    }

    // ═══════════════════════════════════════════════════════════
    // Mode Switching — Real UCI implementation
    // ═══════════════════════════════════════════════════════════

    /**
     * Switch to router mode: remove STA interfaces, ensure WAN interface exists,
     * set DHCP on LAN, re-enable AP interfaces.
     */
    private fun switchToRouter(body: JSONObject): Response {
        return try {
            val wireless = uciOf("wireless")
            // Remove any STA interfaces (leftovers from repeater mode)
            wireless.keys().forEach { k ->
                val s = wireless.optJSONObject(k) ?: return@forEach
                if (s.optString(".type") == "wifi-iface" && s.optString("mode") == "sta")
                    uciDelete("wireless", k)
            }
            // Re-enable AP interfaces
            wireless.keys().forEach { k ->
                val s = wireless.optJSONObject(k) ?: return@forEach
                if (s.optString(".type") == "wifi-iface" && s.optString("mode") == "ap")
                    uciSet("wireless", k, JSONObject().put("disabled", "0"))
            }
            // Delete wwan interface if present
            uciDelete("network", "wwan"); uciDelete("dhcp", "wwan")
            // Ensure LAN is static with DHCP enabled
            uciSet("network", "lan", JSONObject().put("proto", "static").put("ipv6", "0"))
            val dhcpCfg = uciOf("dhcp")
            val lanDhcpKey = dhcpCfg.keys().asSequence().firstOrNull { k ->
                dhcpCfg.optJSONObject(k)?.let { it.optString(".type") == "dhcp" && (it.optString("interface") == "lan" || it.optString(".name") == "lan") } == true
            } ?: "lan"
            uciSet("dhcp", lanDhcpKey, JSONObject().put("ignore", "0"))
            uciCommit("wireless", "network", "dhcp"); uciApply()
            ok(JSONObject().put("mode", "router").put("ok", true).put("pending", true))
        } catch (e: Exception) {
            err(Response.Status.INTERNAL_ERROR, "Mode switch failed: ${e.message}")
        }
    }

    /**
     * Switch to Access Point mode: disable DHCP on LAN, remove WAN interface,
     * keep AP wireless interfaces active.
     */
    private fun switchToAP(body: JSONObject): Response {
        return try {
            // Disable DHCP on LAN (it will be served by the main router upstream)
            val dhcpCfg = uciOf("dhcp")
            val lanDhcpKey = dhcpCfg.keys().asSequence().firstOrNull { k ->
                dhcpCfg.optJSONObject(k)?.let { it.optString(".type") == "dhcp" && (it.optString("interface") == "lan" || it.optString(".name") == "lan") } == true
            } ?: "lan"
            uciSet("dhcp", lanDhcpKey, JSONObject().put("ignore", "1"))
            // Set LAN to DHCP client so it gets an address from the upstream router
            uciSet("network", "lan", JSONObject().put("proto", "dhcp").put("ipv6", "0"))
            // Remove WAN interface
            uciDelete("network", "wan")
            // Remove any STA interfaces
            val wireless = uciOf("wireless")
            wireless.keys().forEach { k ->
                val s = wireless.optJSONObject(k) ?: return@forEach
                if (s.optString(".type") == "wifi-iface" && s.optString("mode") == "sta")
                    uciDelete("wireless", k)
            }
            uciCommit("wireless", "network", "dhcp"); uciApply()
            ok(JSONObject().put("mode", "ap").put("ok", true).put("pending", true))
        } catch (e: Exception) {
            err(Response.Status.INTERNAL_ERROR, "Mode switch failed: ${e.message}")
        }
    }

    /**
     * Switch to Repeater mode: create a STA wifi-iface for the upstream network,
     * create a wwan network interface bridged to LAN for DHCP, disable DHCP server.
     */
    private fun switchToRepeater(body: JSONObject): Response {
        return try {
            val upstreamSsid = body.optString("ssid").ifEmpty { return err(Response.Status.BAD_REQUEST, "SSID required") }
            val upstreamPass = body.optString("password", "")
            val radioId = body.optString("radio", firstRadioId() ?: return err(Response.Status.BAD_REQUEST, "No radio found"))

            val wireless = uciOf("wireless")
            val networkCfg = uciOf("network")

            // Remove any existing STA interfaces to avoid duplicates
            wireless.keys().forEach { k ->
                val s = wireless.optJSONObject(k) ?: return@forEach
                if (s.optString(".type") == "wifi-iface" && s.optString("mode") == "sta")
                    uciDelete("wireless", k)
            }

            // Add STA interface (always fresh after deleting old ones above)
            val staName = "wwan_sta"
            uciAdd("wireless", staName, "wifi-iface")
            uciSet("wireless", staName, JSONObject()
                .put("device", radioId).put("mode", "sta").put("network", "wwan")
                .put("ssid", upstreamSsid)
                .also { if (upstreamPass.isNotEmpty()) it.put("encryption", "psk2").put("key", upstreamPass) else it.put("encryption", "none") })

            // Create wwan network interface only if it doesn't already exist
            val wwanExists = networkCfg.keys().asSequence().any { k ->
                networkCfg.optJSONObject(k)?.optString(".name") == "wwan" ||
                networkCfg.has("wwan")
            }
            if (!wwanExists) uciAdd("network", "wwan", "interface")
            uciSet("network", "wwan", JSONObject().put("proto", "dhcp").put("ipv6", "0"))

            // Keep DHCP for LAN clients
            val dhcpCfg = uciOf("dhcp")
            val lanDhcpKey = dhcpCfg.keys().asSequence().firstOrNull { k ->
                dhcpCfg.optJSONObject(k)?.let { it.optString(".type") == "dhcp" && (it.optString("interface") == "lan" || it.optString(".name") == "lan") } == true
            } ?: "lan"
            uciSet("dhcp", lanDhcpKey, JSONObject().put("ignore", "0"))

            uciCommit("wireless", "network", "dhcp"); uciApply()
            ok(JSONObject().put("mode", "repeater").put("ok", true).put("pending", true)
                .put("message", "Connecting to \"$upstreamSsid\"... Router will apply settings."))
        } catch (e: Exception) {
            err(Response.Status.INTERNAL_ERROR, "Mode switch failed: ${e.message}")
        }
    }


    // ═══════════════════════════════════════════════════════════
    // Diagnostics
    // ═══════════════════════════════════════════════════════════
    private fun runDiagnostic(type: String, body: JSONObject): Response {
        val host = body.optString("host").trim()
        if (host.isEmpty() || !host.matches(Regex("^[a-zA-Z0-9.-]+$")) || host.startsWith("-"))
            return err(Response.Status.BAD_REQUEST, "A valid hostname or IP address is required.")
        val (command, params) = when (type) {
            "ping" -> Pair("/bin/ping", JSONArray().put("-c").put("4").put("-W").put("2").put(host))
            else   -> Pair("/usr/bin/traceroute", JSONArray().put("-m").put("15").put("-w").put("2").put("-q").put("1").put(host))
        }
        val result = tryCall("file", "exec", JSONObject().put("command", command).put("params", params))
        return ok(JSONObject().put("output", result?.optString("stdout") ?: result?.optString("stderr") ?: "No output received.").put("code", result?.optInt("code", -1) ?: -1))
    }

    // ═══════════════════════════════════════════════════════════
    // System
    // ═══════════════════════════════════════════════════════════
    private fun buildSystemOverview(): Response {
        val board = tryCall("system", "board") ?: JSONObject()
        val sysInfo = tryCall("system", "info")
        val memInfo = sysInfo?.optJSONObject("memory") ?: JSONObject()
        val memTotal = memInfo.optLong("total", 0)
        val memFree = memInfo.optLong("free", 0) + memInfo.optLong("buffered", 0)
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
        tryCall("system", "reboot"); return ok(JSONObject().put("ok", true))
    }

    // ═══════════════════════════════════════════════════════════
    // Bandwidth — delta calculation for bytes/sec
    // ═══════════════════════════════════════════════════════════
    private fun buildBandwidth(): Response {
        val devices = tryCall("network.device", "status") ?: JSONObject()

        // Pick best WAN candidate: highest-traffic non-loopback/bridge interface
        var primaryRx = 0L; var primaryTx = 0L; var primaryIface = ""
        devices.keys().forEach { name ->
            val d = devices.optJSONObject(name) ?: return@forEach
            val stats = d.optJSONObject("statistics") ?: return@forEach
            if (name.matches(Regex("^(lo|br-lan).*"))) return@forEach
            val rx = stats.optLong("rx_bytes", 0); val tx = stats.optLong("tx_bytes", 0)
            if (rx + tx > primaryRx + primaryTx) { primaryRx = rx; primaryTx = tx; primaryIface = name }
        }

        val hasData = primaryIface.isNotEmpty()

        // Compute bytes/sec from two consecutive samples
        val now = System.currentTimeMillis()
        val prev = lastBwSample
        var rxRate: Long? = null; var txRate: Long? = null

        if (hasData && prev != null && prev.iface == primaryIface) {
            val elapsed = (now - prev.ts).toDouble() / 1000.0
            if (elapsed > 0.5) {
                rxRate = maxOf(0L, ((primaryRx - prev.rx).toDouble() / elapsed).toLong())
                txRate = maxOf(0L, ((primaryTx - prev.tx).toDouble() / elapsed).toLong())
            }
        }
        if (hasData) lastBwSample = BwSample(now, primaryRx, primaryTx, primaryIface)

        // Build total object matching what frontend usagePanel() expects
        val total = if (hasData) JSONObject()
            .put("available", true)
            .put("reason", if (rxRate != null) null else "Collecting first sample — this updates in a few seconds.")
            .put("rxRate", rxRate)   // bytes/sec download
            .put("txRate", txRate)   // bytes/sec upload
            .put("rxBytes", primaryRx)
            .put("txBytes", primaryTx)
            .put("interface", primaryIface)
        else JSONObject()
            .put("available", false)
            .put("reason", "No active WAN interface found. Connect to internet first.")
            .put("rxRate", null).put("txRate", null).put("rxBytes", null).put("txBytes", null)

        return ok(JSONObject()
            .put("total", total)
            .put("limits", JSONObject()
                .put("available", false)
                .put("reason", "Speed limits require sqm-scripts, which is not installed on this router."))
            .put("perDevice", JSONObject()
                .put("available", false)
                .put("reason", "Per-device tracking requires nlbwmon, which is not installed on this router."))
            .put("perDeviceLimits", JSONObject()
                .put("available", false)
                .put("reason", "Per-device limits require nft-qos, which is not installed on this router.")))
    }


    // ═══════════════════════════════════════════════════════════
    // Utilities
    // ═══════════════════════════════════════════════════════════
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
