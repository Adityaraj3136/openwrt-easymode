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
// Bind to loopback only: the WebView loads http://localhost:8080, which resolves to
// 127.0.0.1. The port-only constructor would bind 0.0.0.0 (all interfaces), exposing
// router control to every device on the LAN. Loopback removes remote reachability.
class EasyModeServer(private val context: Context, port: Int) : NanoHTTPD("127.0.0.1", port) {

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

    // Short-lived cache for the client list. collectClients() makes many sequential ubus
    // round-trips (host hints, leases, per-interface assoclist); the dashboard polls it
    // alongside DHCP, so a 3s TTL collapses duplicate work without showing stale data.
    private var clientsCache: Pair<JSONArray, Boolean>? = null
    private var clientsCacheAt: Long = 0L
    private val clientsCacheTtlMs = 3000L

    // Runtime ifname resolution hits iwinfo repeatedly; names are stable for a session,
    // so memoise them keyed by "radioId|mode|apIndex".
    private val ifnameCache = HashMap<String, String>()

    // ── Called by MainActivity when Wi-Fi network changes ────
    fun onNetworkChanged() {
        val newGateway = getGatewayIp()
        if (newGateway != "192.168.1.1" && newGateway != activeRouterIp) {
            // New network detected — clear session so user re-authenticates
            activeSid = ""
            activeRouterIp = newGateway
            invalidateCaches()
        }
    }

    // Drop cached client list and interface names — call after anything that changes
    // the network topology (mode switch, new uplink) so the next read is fresh.
    private fun invalidateCaches() {
        clientsCache = null
        clientsCacheAt = 0L
        ifnameCache.clear()
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
    private fun err(status: Response.Status, msg: String, code: String = "ERROR"): Response =
        newFixedLengthResponse(status, "application/json",
            JSONObject().put("error", JSONObject().put("code", code).put("message", msg)).toString())

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

    private fun uciDeleteOption(config: String, section: String, option: String) {
        try { ubus.call(activeRouterIp, activeSid, "uci", "delete",
            JSONObject().put("config", config).put("section", section).put("option", option))
        } catch (_: Exception) {}
    }

    /** Creates a named section of the given type if absent, then applies values. */
    private fun uciEnsure(config: String, section: String, type: String, values: JSONObject) {
        if (uciOf(config).optJSONObject(section) == null) uciAdd(config, section, type)
        if (values.length() > 0) uciSet(config, section, values)
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

    // ── Rollback primitives ───────────────────────────────────
    // OpenWrt's own safety net: `uci apply {rollback:true, timeout:N}` stages the change
    // and arms a timer. If `uci confirm` is not called within N seconds, the router reverts
    // everything on its own — the real protection against a change that locks us out.

    /**
     * Apply staged changes behind the rollback timer. Returns true if the router accepted
     * the rollback-armed apply, false if this build doesn't support it (caller should then
     * fall back to a plain commit + snapshot restore). Throws only on transport failure.
     */
    private fun uciApplyConfirm(timeoutSeconds: Int): Boolean {
        return try {
            ubus.call(activeRouterIp, activeSid, "uci", "apply",
                JSONObject().put("rollback", true).put("timeout", timeoutSeconds))
            true
        } catch (e: Exception) {
            // Some vendor rpcd builds advertise apply/confirm/rollback but return NO_DATA
            // (ubus code 6) when actually called. Treat that as "not supported".
            false
        }
    }

    /** Commit the staged change for good, cancelling the rollback timer. */
    private fun uciConfirm(): Boolean =
        try { ubus.call(activeRouterIp, activeSid, "uci", "confirm", JSONObject()); true }
        catch (_: Exception) { false }

    /** Immediately revert the staged change instead of waiting for the timer. */
    private fun uciRollback(): Boolean =
        try { ubus.call(activeRouterIp, activeSid, "uci", "rollback", JSONObject()); true }
        catch (_: Exception) { false }

    // ── Config snapshot / restore (fallback for builds without rollback) ──
    // When the router lacks uci apply/confirm/rollback we can't rely on its timer, so we
    // capture the affected configs before the change and write them back if the new state
    // turns out wrong. This only helps while the router is still reachable — it is not a
    // substitute for the rollback timer's lock-out protection, just a best effort.

    private val META_KEYS = setOf(".name", ".type", ".anonymous", ".index")

    /** Options of a section minus ubus metadata keys. */
    private fun optionsOf(section: JSONObject): JSONObject {
        val out = JSONObject()
        section.keys().forEach { k -> if (k !in META_KEYS) out.put(k, section.get(k)) }
        return out
    }

    /** Read the given configs into an in-memory snapshot. */
    private fun snapshotConfigs(vararg configs: String): JSONObject {
        val snap = JSONObject()
        configs.forEach { cfg -> snap.put(cfg, uciOf(cfg)) }
        return snap
    }

    /**
     * Write a snapshot back section by section: restore known options, remove options and
     * sections that appeared after the snapshot was taken. Does NOT commit/apply — the
     * caller decides how to persist (so it can reuse the same rollback path).
     */
    private fun restoreSnapshot(snapshot: JSONObject) {
        snapshot.keys().forEach { config ->
            val sections = snapshot.optJSONObject(config) ?: return@forEach
            val current = uciOf(config)

            sections.keys().forEach { name ->
                val section = sections.optJSONObject(name) ?: return@forEach
                val wanted = optionsOf(section)
                val existing = current.optJSONObject(name)
                if (existing == null) {
                    uciEnsure(config, name, section.optString(".type"), wanted)
                } else {
                    // Drop options that were added after the snapshot.
                    optionsOf(existing).keys().forEach { opt ->
                        if (!wanted.has(opt)) uciDeleteOption(config, name, opt)
                    }
                    if (wanted.length() > 0) uciSet(config, name, wanted)
                }
            }
            // Remove sections that didn't exist in the snapshot.
            current.keys().forEach { name ->
                if (!sections.has(name)) uciDelete(config, name)
            }
        }
    }

    /**
     * Probe for the router after a change, following it to a new address if it moved
     * (e.g. a LAN IP change). Tries the current IP plus any candidates, retrying until one
     * answers or the deadline passes. Updates activeRouterIp on success. Returns true if the
     * router is reachable again.
     *
     * Bounded by an absolute wall-clock deadline (not an attempt count) because each failed
     * ubus.call burns up to the OkHttp connect timeout (~5s). When called under an armed
     * rollback timer, the caller passes a deadline safely inside that timer so we always
     * return with time left to send confirm/rollback — never after the router self-reverted.
     */
    private fun reconnectAfterChange(candidates: List<String>, deadline: Long, delayMs: Long = 1500): Boolean {
        val hosts = (listOf(activeRouterIp) + candidates).filter { it.isNotEmpty() }.distinct()
        while (true) {
            for (h in hosts) {
                try {
                    ubus.call(h, activeSid, "system", "board")
                    if (h != activeRouterIp) { activeRouterIp = h; invalidateCaches() }
                    return true
                } catch (_: Exception) {}
                if (System.currentTimeMillis() >= deadline) return false
            }
            if (System.currentTimeMillis() + delayMs >= deadline) return false
            try { Thread.sleep(delayMs) } catch (_: InterruptedException) {}
        }
    }

    /**
     * Commit staged UCI changes behind the rollback timer, wait for the router to settle,
     * confirm that it still answers (following it to a new address if given), optionally
     * verify the new state, then confirm the change. If contact is lost we never confirm,
     * so the router's own timer reverts everything — the lock-out protection. On builds
     * without rollback we fall back to a plain commit plus snapshot restore on failure.
     *
     * Callers must have already STAGED their changes (uciSet/uciDelete/uciEnsure) and must
     * NOT have committed — the rollback-armed apply performs the commit.
     *
     * @return true if the change was applied and confirmed; false if it was reverted.
     */
    private fun commitWithRollback(
        configs: List<String>,
        candidates: List<String> = emptyList(),
        timeoutSeconds: Int = 90,
        settleMs: Long = 2500,
        verify: (() -> Boolean)? = null,
    ): Boolean {
        // Restore point for the no-rollback fallback path.
        val snapshot = snapshotConfigs(*configs.toTypedArray())
        val armed = uciApplyConfirm(timeoutSeconds)

        if (!armed) {
            // rpcd lacks apply/confirm/rollback: commit directly and reload, then verify.
            // No rollback timer here, so probe generously (30s) — there's nothing to race.
            uciCommit(*configs.toTypedArray()); uciApply()
            try { Thread.sleep(settleMs) } catch (_: InterruptedException) {}
            if (!reconnectAfterChange(candidates, System.currentTimeMillis() + 30_000)) return false
            if (verify != null && !verify()) {
                restoreSnapshot(snapshot); uciCommit(*configs.toTypedArray()); uciApply()
                return false
            }
            return true
        }

        // Rollback armed: we MUST confirm (or rollback) before the router's timer fires, or
        // it reverts on its own and our confirm would be a lie. Reserve a safety margin so
        // the reconnect probe always finishes with time left to send confirm/rollback.
        val margin = 10_000L
        val deadline = System.currentTimeMillis() + (timeoutSeconds * 1000L) - margin

        try { Thread.sleep(settleMs) } catch (_: InterruptedException) {}
        if (!reconnectAfterChange(candidates, deadline)) {
            // Lost contact — do NOT confirm. The router reverts itself when the timer fires.
            return false
        }
        if (verify != null && !verify()) {
            uciRollback()
            return false
        }
        uciConfirm()
        return true
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
            val resp = newChunkedResponse(Response.Status.OK, getMimeTypeForFile(path),
                context.assets.open("frontend/$path"))
            // Assets ship inside the APK and change only on update. Tell the WebView never
            // to cache them so an updated build is always reflected immediately.
            resp.addHeader("Cache-Control", "no-store, no-cache, must-revalidate")
            resp.addHeader("Pragma", "no-cache")
            resp
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

        // Check session via cookie matching the stored SID.
        val cookieSid = session.cookies.read("sysauth_http") ?: ""
        val storedSid = activeSid
        // Public endpoints need no session. /api/auth/session is also allowed through here:
        // it self-authenticates by re-validating the stored SID against the router, and it
        // must work right after an app restart when the (session-scoped) cookie is gone.
        val isPublic = uri == "/api/auth/config" || uri == "/api/auth/login" ||
            uri == "/api/auth/session"

        // Every data endpoint now requires the cookie to match the stored SID. The old
        // `|| cookieSid.isEmpty()` bypass — which treated a cookie-less request as valid —
        // has been removed so a request without the session cookie can't reach the router.
        val sessionValid = storedSid.isNotEmpty() && cookieSid == storedSid
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
        if (uri == "/api/wifi/guest" && method == Method.GET) return buildGuestWifi()
        if (uri == "/api/wifi/guest" && method == Method.POST) return updateGuestWifi(body)

        // ── DHCP ─────────────────────────────────────────────────
        if (uri == "/api/dhcp" && method == Method.GET) return buildDhcp()
        if (uri == "/api/dhcp" && method == Method.POST) return updateDhcp(body)
        if (uri == "/api/lan" && method == Method.GET) return buildLan()
        if (uri == "/api/lan" && method == Method.POST) return updateLan(body)
        if (uri == "/api/ipv6" && method == Method.GET) return buildIpv6()
        if (uri == "/api/ipv6" && method == Method.POST) return updateIpv6(body)
        if (uri == "/api/dhcp/reservations" && method == Method.POST) return addReservation(body)
        if (uri.startsWith("/api/dhcp/reservations/") && method == Method.DELETE)
            return deleteReservation(uri.removePrefix("/api/dhcp/reservations/"))
        if (uri == "/api/dhcp/blocked" && method == Method.POST) return blockClient(body)
        if (uri.startsWith("/api/dhcp/blocked/") && method == Method.DELETE)
            return unblockClient(uri.removePrefix("/api/dhcp/blocked/"))

        // ── Mode switching ───────────────────────────────────────
        // A mode switch changes interfaces/topology, so drop cached ifnames + client list.
        if (uri.startsWith("/api/mode/") && method == Method.POST) invalidateCaches()
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
        // Use WAN interface up status as internet indicator
        // Ping-based check would add 2s latency to every dashboard load
        val internet = JSONObject().put("online", wanUp).put("method", "settings")
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

        // Connected devices, merged from luci-rpc (leases + host hints) and iwinfo
        // assoclist — the same sources LuCI uses, so it works without file access.
        val (clientDevices, available) = collectClients()
        var wiredCount = 0
        var wirelessCount = 0
        for (i in 0 until clientDevices.length()) {
            if (clientDevices.optJSONObject(i)?.optBoolean("isWireless", false) == true) wirelessCount++ else wiredCount++
        }
        val reason: String? = if (available) null else "Client list requires luci-rpc or file access on the router"

        // Compute CIDR and gateway for dashboard home-network panel
        val lanIpStr = ipv4(lanIface)
        val lanDevice = lanIface?.optString("l3_device") ?: lanIface?.optString("device")
        val lanRoutes = lanIface?.optJSONArray("route") ?: JSONArray()
        var lanGateway: String? = null
        for (r in 0 until lanRoutes.length()) {
            val route = lanRoutes.optJSONObject(r) ?: continue
            if (route.optString("target") == "0.0.0.0") {
                lanGateway = route.optString("nexthop", null)
                break
            }
        }
        val lanPrefix = lanIface?.optJSONArray("ipv4-address")?.let {
            if (it.length() > 0) it.getJSONObject(0).optInt("mask", 24) else 24
        } ?: 24
        val cidr = if (lanIpStr != null) "$lanIpStr/$lanPrefix" else null

        val lan = JSONObject()
            .put("present", lanIface != null).put("up", lanIface?.optBoolean("up") ?: false)
            .put("ip", lanIpStr).put("device", lanDevice)
            .put("cidr", cidr).put("gateway", lanGateway)
            .put("dhcpEnabled", dhcpEnabled)
            .put("clients", JSONObject()
                .put("count", if (available) clientDevices.length() else JSONObject.NULL)
                .put("wiredCount", if (available) wiredCount else JSONObject.NULL)
                .put("wirelessCount", if (available) wirelessCount else JSONObject.NULL)
                .put("available", available)
                .put("reason", reason)
                .put("devices", clientDevices))
        // Extract WAN gateway and DNS
        val wanRoutes = wanIface?.optJSONArray("route") ?: JSONArray()
        var wanGateway: String? = null
        for (r in 0 until wanRoutes.length()) {
            val route = wanRoutes.optJSONObject(r) ?: continue
            if (route.optString("target") == "0.0.0.0") {
                wanGateway = route.optString("nexthop", null)
                break
            }
        }
        val wanDns = JSONArray()
        val dnsServers = wanIface?.optJSONArray("dns-server")
        if (dnsServers != null) {
            for (i in 0 until dnsServers.length()) wanDns.put(dnsServers.optString(i))
        }
        val wanDeviceObj = devices.optJSONObject(wanDevice ?: "")
        val wanCarrier = wanDeviceObj?.let { if (it.has("carrier")) it.optBoolean("carrier") else null }

        val wan = JSONObject()
            .put("present", wanIface != null).put("up", wanIface?.optBoolean("up") ?: false)
            .put("interface", wanIface?.optString("interface"))
            .put("kind", if (wanIface == null) "none" else if (wanIsWireless) "wireless" else "ethernet")
            .put("proto", wanIface?.optString("proto")).put("device", wanDevice)
            .put("ip", ipv4(wanIface)).put("uptimeSeconds", wanIface?.optLong("uptime", 0) ?: 0)
            .put("gateway", wanGateway).put("dns", wanDns).put("carrier", wanCarrier)
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
                .put("router", JSONObject().put("ready", true))
                .put("ap", JSONObject().put("ready", true).put("suggestedUplink", "wan")))
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
        val radios = buildRadiosArray(true)
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
            var apIndex = 0

            val netRadio = netWireless.optJSONObject(k)
            val netInterfaces = netRadio?.optJSONArray("interfaces") ?: JSONArray()

            wireless.keys().forEach { ik ->
                val iface = wireless.optJSONObject(ik) ?: return@forEach
                val iType = iface.optString(".type").ifEmpty { if (ik.matches(Regex("radio\\d+"))) "wifi-device" else "wifi-iface" }

                if (iType == "wifi-iface" && iface.optString("device") == k) {
                    val mode = iface.optString("mode", "ap")
                    val ssid = iface.optString("ssid", null)

                    var realIfname = iface.optString("ifname", "")
                    for (i in 0 until netInterfaces.length()) {
                        val netIface = netInterfaces.optJSONObject(i) ?: continue
                        val cfg = netIface.optJSONObject("config") ?: JSONObject()
                        if (cfg.optString(".name") == ik || cfg.optString("ssid") == ssid) {
                            val nIf = netIface.optString("ifname", "")
                            if (nIf.isNotEmpty()) realIfname = nIf
                        }
                    }

                    // Vendor firmware (e.g. JioRouter AX6000) doesn't expose
                    // network.wireless.status, so no runtime ifname is discoverable above and
                    // the UCI section rarely carries one. Derive it so assoclist — and thus the
                    // connected-device count — still works.
                    if (realIfname.isEmpty()) realIfname = resolveIfname(k, mode, apIndex)

                    if (mode == "ap" && primarySsid == null) primarySsid = ssid

                    if (detailed && realIfname.isNotEmpty()) {
                        val assoc = tryCall("iwinfo", "assoclist", JSONObject().put("device", realIfname))
                        clients += assoc?.optJSONArray("results")?.length() ?: 0
                    }

                    if (mode == "ap") apIndex++

                    val nwStr = iface.optString("network", "")
                    val nwArr = iface.optJSONArray("network")
                    val netList = nwArr ?: if (nwStr.isNotEmpty()) JSONArray().put(nwStr) else JSONArray()
                    
                    interfaces.put(JSONObject()
                        .put("section", ik)
                        .put("ifname", realIfname)
                        .put("mode", mode)
                        .put("ssid", ssid)
                        .put("key", iface.optString("key", null))
                        .put("network", netList)
                        .put("encryption", iface.optString("encryption", "none"))
                        .put("disabled", iface.optString("disabled", "0") == "1")
                        .put("hidden", iface.optString("hidden", "0") == "1")
                        .put("isolate", iface.optString("isolate", "0") == "1")
                    )
                }
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
                .put("channelConfig", s.optString("channel", "auto"))
                .put("clients", clients)
                .put("interfaces", interfaces)
                .put("capabilities", buildRadioCapabilities(k, s, band))

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
        // Resolve AP ifnames from UCI (network.wireless.status is absent on vendor firmware),
        // then read associated stations from each via iwinfo assoclist.
        val wireless = uciOf("wireless")
        val netWireless = tryCall("network.wireless", "status") ?: JSONObject()
        wireless.keys().forEach { k ->
            val radio = wireless.optJSONObject(k) ?: return@forEach
            val rType = radio.optString(".type").ifEmpty { if (k.matches(Regex("radio\\d+"))) "wifi-device" else "wifi-iface" }
            if (rType != "wifi-device") return@forEach
            val netInterfaces = netWireless.optJSONObject(k)?.optJSONArray("interfaces") ?: JSONArray()
            var apIndex = 0
            wireless.keys().forEach { ik ->
                val iface = wireless.optJSONObject(ik) ?: return@forEach
                if (iface.optString(".type") != "wifi-iface" || iface.optString("device") != k) return@forEach
                if (iface.optString("mode", "ap") != "ap") return@forEach
                val ssid = iface.optString("ssid", "")
                var ifname = iface.optString("ifname", "")
                for (i in 0 until netInterfaces.length()) {
                    val cfg = netInterfaces.optJSONObject(i)?.optJSONObject("config") ?: continue
                    if (cfg.optString(".name") == ik || cfg.optString("ssid") == ssid) {
                        val nIf = netInterfaces.optJSONObject(i)?.optString("ifname", "") ?: ""
                        if (nIf.isNotEmpty()) ifname = nIf
                    }
                }
                if (ifname.isEmpty()) ifname = resolveIfname(k, "ap", apIndex)
                apIndex++
                if (ifname.isEmpty()) return@forEach
                val assoc = tryCall("iwinfo", "assoclist", JSONObject().put("device", ifname))
                assoc?.optJSONArray("results")?.let { results ->
                    for (j in 0 until results.length()) {
                        val e = results.getJSONObject(j)
                        clients.put(JSONObject().put("mac", e.optString("mac")).put("signal", e.opt("signal"))
                            .put("radio", k).put("ssid", ssid)
                            .put("connectedSeconds", e.opt("connected_time")))
                    }
                }
            }
        }
        return ok(JSONObject().put("clients", clients).put("available", true))
    }

    private fun buildWifiScan(radioId: String?): Response {
        val radio = radioId ?: firstRadioId() ?: return ok(JSONObject().put("networks", JSONArray()).put("joinable", JSONObject()).put("congestion", JSONObject()))

        // Pick the interface to scan on. A radio acting as a STA (client) uplink — the band
        // used to connect to the main router in repeater mode — is busy on the associated
        // channel and cannot scan; scanning there fails or drops the uplink. So prefer an AP
        // interface, and if the radio ONLY has a STA interface, report a clear error instead
        // of silently returning an empty list.
        val (scanDevice, staOnly) = resolveScanInterface(radio)
        if (staOnly) {
            return err(Response.Status.INTERNAL_ERROR,
                "This band is connected to your main router, so it can't scan for networks at the same time. Switch to the other band to scan.",
                "SCAN_BAND_BUSY")
        }
        if (scanDevice.isEmpty()) {
            return err(Response.Status.INTERNAL_ERROR,
                "No Wi-Fi interface is available on this band to scan with.", "SCAN_FAILED")
        }

        val scan = tryCall("iwinfo", "scan", JSONObject().put("device", scanDevice))
        if (scan == null) {
            // The scan call itself failed. On a radio that also carries a STA uplink this is
            // usually the busy-band conflict; surface it rather than an empty success.
            return err(Response.Status.INTERNAL_ERROR,
                "The router couldn't scan for Wi-Fi networks right now. If this band is also used to connect to your main router, try the other band.",
                "SCAN_FAILED")
        }
        val networks = JSONArray()
        scan?.optJSONArray("results")?.let { results ->
            for (i in 0 until results.length()) {
                val r = results.getJSONObject(i); val sig = r.optInt("signal", -100)
                val ch = r.optInt("channel", 0)
                val encObj = r.optJSONObject("encryption")
                val encEnabled = encObj?.optBoolean("enabled", false) ?: false
                val encDesc = encObj?.optString("description", "none") ?: "none"
                networks.put(JSONObject().put("ssid", r.optString("ssid")).put("bssid", r.optString("bssid"))
                    .put("signal", sig).put("quality", maxOf(0, minOf(100, (sig + 100) * 2)))
                    .put("channel", ch)
                    .put("band", if (ch > 14) 5 else 2.4)
                    .put("encryption", encEnabled)
                    .put("encryptionMode", encDesc)
                    .put("encryptionLabel", if (encEnabled) encDesc else "Open")
                    .put("needsPassword", encEnabled))
            }
        }
        // Build joinable: deduplicate by SSID, keep the strongest signal per SSID
        val bestByName = mutableMapOf<String, JSONObject>()
        for (i in 0 until networks.length()) {
            val n = networks.optJSONObject(i) ?: continue
            val ssid = n.optString("ssid", "")
            if (ssid.isEmpty()) continue
            val existing = bestByName[ssid]
            if (existing == null || n.optInt("signal", -999) > existing.optInt("signal", -999)) {
                bestByName[ssid] = n
            }
        }
        val joinable = JSONArray()
        bestByName.values.sortedByDescending { it.optInt("signal", -999) }.forEach { joinable.put(it) }

        // Build congestion: count APs per channel
        val channelCounts = mutableMapOf<Int, Int>()
        for (i in 0 until networks.length()) {
            val ch = networks.optJSONObject(i)?.optInt("channel", 0) ?: 0
            if (ch > 0) channelCounts[ch] = (channelCounts[ch] ?: 0) + 1
        }
        val congestion = JSONArray()
        channelCounts.entries.sortedBy { it.key }.forEach { (ch, count) ->
            val level = when { count >= 5 -> "crowded"; count >= 3 -> "moderate"; else -> "clear" }
            congestion.put(JSONObject().put("channel", ch).put("count", count).put("level", level))
        }

        val wireless = uciOf("wireless"); val radios = JSONArray()
        wireless.keys().forEach { k ->
            val s = wireless.optJSONObject(k) ?: return@forEach
            if (s.optString(".type") == "wifi-device")
                radios.put(JSONObject().put("id", k).put("band", bandFromSection(s)).put("label", bandFromSection(s)))
        }
        return ok(JSONObject().put("radio", radio).put("radios", radios).put("networks", networks)
            .put("joinable", joinable).put("congestion", congestion))
    }

    private fun applyRadioSettings(radioId: String, body: JSONObject): Response {
        val wireless = uciOf("wireless")
        // Update device-level settings
        val deviceValues = JSONObject()
        if (body.has("channel")) deviceValues.put("channel", body.opt("channel"))
        if (body.has("txpower")) deviceValues.put("txpower", body.opt("txpower"))
        if (body.has("htmode")) deviceValues.put("htmode", body.optString("htmode"))
        if (body.has("country") && body.optString("country").isNotEmpty()) deviceValues.put("country", body.optString("country").uppercase())
        if (body.has("enabled")) deviceValues.put("disabled", if (body.optBoolean("enabled")) "0" else "1")
        if (deviceValues.length() > 0) uciSet("wireless", radioId, deviceValues)

        // Update AP interface: ssid, key, encryption, hidden, isolate, enabled.
        // mode defaults to "ap": a UCI wifi-iface with no explicit `option mode` IS an AP,
        // so matching on optString("mode") (empty default) would skip it and silently drop
        // every SSID/password/security change.
        wireless.keys().forEach { k ->
            val s = wireless.optJSONObject(k) ?: return@forEach
            if (s.optString(".type") != "wifi-iface" || s.optString("device") != radioId || s.optString("mode", "ap") != "ap") return@forEach
            val ifaceValues = JSONObject()
            if (body.has("ssid")) ifaceValues.put("ssid", body.getString("ssid"))
            if (body.has("encryption")) ifaceValues.put("encryption", body.optString("encryption"))
            if (body.has("key") && body.optString("key").isNotEmpty()) {
                ifaceValues.put("key", body.getString("key"))
            }
            if (body.has("hidden")) ifaceValues.put("hidden", if (body.optBoolean("hidden")) "1" else "0")
            if (body.has("isolate")) ifaceValues.put("isolate", if (body.optBoolean("isolate")) "1" else "0")
            if (body.has("enabled")) ifaceValues.put("disabled", if (body.optBoolean("enabled")) "0" else "1")
            if (ifaceValues.length() > 0) uciSet("wireless", k, ifaceValues)
        }
        uciCommit("wireless"); uciApply()
        // Nudge the wireless subsystem so the new settings take effect immediately.
        // uci apply reloads via config triggers on stock OpenWrt, but vendor firmware
        // often needs an explicit reload; both are best-effort.
        tryCall("network.wireless", "reload")
        tryCall("file", "exec", JSONObject().put("command", "/sbin/wifi").put("params", JSONArray().put("reload")))
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
    // Guest Wi-Fi
    // ═══════════════════════════════════════════════════════════
    private fun buildGuestWifi(): Response {
        val wireless = uciOf("wireless")
        // Look for a guest Wi-Fi interface: network contains 'guest' or ssid starts with 'Guest'
        var guestIface: JSONObject? = null
        var guestSection: String? = null
        wireless.keys().forEach { k ->
            val s = wireless.optJSONObject(k) ?: return@forEach
            if (s.optString(".type") != "wifi-iface") return@forEach
            val nw = s.optString("network", "")
            val ssid = s.optString("ssid", "")
            if (nw.contains("guest", ignoreCase = true) || ssid.startsWith("Guest", ignoreCase = true)) {
                guestIface = s; guestSection = k
            }
        }
        val guestIp = uciOf("network").optJSONObject("guest")?.optString("ipaddr", "")?.ifEmpty { null } ?: "192.168.22.1"
        if (guestIface == null) {
            return ok(JSONObject().put("enabled", false).put("ssid", "Guest Network")
                .put("encryption", "none").put("key", JSONObject.NULL)
                .put("ipaddr", guestIp).put("isolate", true).put("hidden", false))
        }
        val g = guestIface!!
        return ok(JSONObject()
            .put("enabled", g.optString("disabled", "0") != "1")
            .put("ssid", g.optString("ssid", "Guest Network"))
            .put("encryption", g.optString("encryption", "none"))
            .put("key", g.optString("key", null))
            .put("ipaddr", guestIp)
            .put("isolate", g.optString("isolate", "1") == "1")
            .put("hidden", g.optString("hidden", "0") == "1"))
    }

    private fun updateGuestWifi(body: JSONObject): Response {
        val enabled = if (body.has("enabled")) body.optBoolean("enabled") else true
        val ssid = if (body.has("ssid")) body.optString("ssid") else "Guest Network"
        val encryption = if (body.has("encryption")) body.optString("encryption") else "psk2"
        val key = body.optString("key", "")
        val isolate = if (body.has("isolate")) body.optBoolean("isolate") else true
        val hidden = if (body.has("hidden")) body.optBoolean("hidden") else false

        // Pick a guest subnet that doesn't collide with the LAN.
        var guestIp = body.optString("ipaddr", "").ifEmpty { "192.168.22.1" }
        val network = uciOf("network")
        val lanIp = network.optJSONObject("lan")?.optString("ipaddr", "") ?: ""
        if (lanIp.isNotEmpty() && lanIp.substringBeforeLast('.') == guestIp.substringBeforeLast('.')) {
            guestIp = "192.168.23.1"
        }

        // 1. Guest network interface. No type:'bridge' — netifd bridges the AP iface via
        //    the wifi-iface `network` option; forcing a bridge breaks DHCP on MTK drivers.
        uciEnsure("network", "guest", "interface", JSONObject()
            .put("proto", "static")
            .put("ipaddr", guestIp).put("netmask", "255.255.255.0"))

        // 2. Guest DHCP server.
        uciEnsure("dhcp", "guest", "dhcp", JSONObject()
            .put("interface", "guest")
            .put("start", "100").put("limit", "150").put("leasetime", "12h").put("ignore", "0"))

        // 3. Firewall: guest zone (isolated from LAN), forward to WAN, allow DNS+DHCP.
        val firewall = uciOf("firewall")
        fun firewallHas(type: String, match: (JSONObject) -> Boolean): Boolean =
            firewall.keys().asSequence().any { k ->
                firewall.optJSONObject(k)?.let { it.optString(".type") == type && match(it) } == true
            }
        if (!firewallHas("zone") { it.optString("name") == "guest" }) {
            uciEnsure("firewall", "guest_zone", "zone", JSONObject()
                .put("name", "guest")
                .put("network", JSONArray().put("guest"))
                .put("input", "REJECT").put("output", "ACCEPT").put("forward", "REJECT"))
        }
        if (!firewallHas("forwarding") { it.optString("src") == "guest" && it.optString("dest") == "wan" }) {
            uciEnsure("firewall", "guest_fwd", "forwarding", JSONObject()
                .put("src", "guest").put("dest", "wan"))
        }
        if (!firewallHas("rule") { it.optString("name") == "Guest_DNS" }) {
            uciEnsure("firewall", "guest_dns", "rule", JSONObject()
                .put("name", "Guest_DNS").put("src", "guest")
                .put("dest_port", "53").put("proto", "tcp udp").put("target", "ACCEPT"))
        }
        if (!firewallHas("rule") { it.optString("name") == "Guest_DHCP" }) {
            uciEnsure("firewall", "guest_dhcp_rule", "rule", JSONObject()
                .put("name", "Guest_DHCP").put("src", "guest")
                .put("dest_port", "67").put("proto", "udp").put("target", "ACCEPT"))
        }

        // 4. Guest AP on each radio that isn't carrying a repeater (STA) uplink.
        val wireless = uciOf("wireless")
        val guestRadios = mutableListOf<String>()
        wireless.keys().forEach { k ->
            val s = wireless.optJSONObject(k) ?: return@forEach
            val rType = s.optString(".type").ifEmpty { if (k.matches(Regex("radio\\d+"))) "wifi-device" else "wifi-iface" }
            if (rType != "wifi-device") return@forEach

            val hasSta = wireless.keys().asSequence().any { ik ->
                wireless.optJSONObject(ik)?.let {
                    it.optString(".type") == "wifi-iface" && it.optString("device") == k &&
                        it.optString("mode") == "sta" && it.optString("disabled", "0") != "1"
                } == true
            }
            // Find any existing guest iface on this radio.
            var existing: String? = null
            wireless.keys().forEach { ik ->
                val iface = wireless.optJSONObject(ik) ?: return@forEach
                if (iface.optString(".type") == "wifi-iface" && iface.optString("device") == k &&
                    iface.optString("network") == "guest") existing = ik
            }
            if (hasSta) {
                // Can't run AP+STA+AP on the same chip; drop guest here.
                if (existing != null) uciDelete("wireless", existing!!)
                return@forEach
            }

            guestRadios.add(k)
            val section = existing ?: uciAdd("wireless", "guest_${k}", "wifi-iface")
            val values = JSONObject()
                .put("device", k).put("mode", "ap").put("network", "guest")
                .put("ssid", ssid).put("encryption", encryption)
                .put("disabled", if (enabled) "0" else "1")
                .put("isolate", if (isolate) "1" else "0")
                .put("hidden", if (hidden) "1" else "0")
            if (encryption != "none" && key.isNotEmpty()) values.put("key", key)
            uciSet("wireless", section, values)
            if (encryption == "none") uciDeleteOption("wireless", section, "key")
        }

        uciCommit("network", "dhcp", "firewall", "wireless")
        uciApply()

        // Reload only the radios hosting the guest AP so a repeater uplink stays up.
        if (guestRadios.isNotEmpty()) {
            guestRadios.forEach { rid ->
                tryCall("file", "exec", JSONObject().put("command", "/sbin/wifi").put("params", JSONArray().put("reload").put(rid)))
            }
        } else {
            tryCall("file", "exec", JSONObject().put("command", "/sbin/wifi").put("params", JSONArray().put("reload")))
        }
        tryCall("network.wireless", "reload")
        tryCall("network.interface.guest", "up")

        return buildGuestWifi()
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
        val dnsArr = JSONArray()
        lanSec?.let { sec ->
            when (val raw = sec.opt("dhcp_option") ?: sec.opt("dns")) {
                is JSONArray -> for (i in 0 until raw.length()) {
                    val entry = raw.optString(i)
                    if (entry.startsWith("6,")) entry.removePrefix("6,").split(",").forEach { dnsArr.put(it.trim()) }
                    else if (entry.isNotEmpty()) dnsArr.put(entry.trim())
                }
                is String -> if (raw.isNotEmpty()) raw.split(" ", ",").forEach { if (it.isNotBlank()) dnsArr.put(it.trim()) }
                else -> Unit
            }
        }
        val start = lanSec?.optInt("start", 100) ?: 100
        val limit = lanSec?.optInt("limit", 150) ?: 150
        val prefix = activeRouterIp.substringBeforeLast('.')
        val rangeStart = "$prefix.$start"
        val rangeEnd = "$prefix.${start + limit - 1}"

        // Connected devices, from luci-rpc (leases + host hints) + iwinfo assoclist —
        // the same sources LuCI uses, so names and IPs show without file access.
        val (clients, clientsAvailable) = collectClients()
        val leases = JSONArray()
        val leasesAvailable = clientsAvailable
        for (i in 0 until clients.length()) {
            val c = clients.optJSONObject(i) ?: continue
            val host = if (c.isNull("hostname")) null else c.optString("hostname")
            leases.put(JSONObject()
                .put("mac", c.optString("mac"))
                .put("ip", if (c.isNull("ip")) JSONObject.NULL else c.optString("ip"))
                .put("hostname", host).put("name", host)
                .put("expiresAt", c.opt("leaseExpiresAt") ?: JSONObject.NULL)
                .put("isWireless", c.optBoolean("isWireless", false))
                .put("signal", c.opt("signal") ?: JSONObject.NULL)
                .put("reserved", false).put("blocked", false))
        }

        // Check for blocked clients in firewall
        val firewallCfg = uciOf("firewall")
        val blocked = JSONArray()
        firewallCfg.keys().forEach { k ->
            val s = firewallCfg.optJSONObject(k) ?: return@forEach
            if (s.optString(".type") == "rule" && s.optString("target") == "REJECT" && s.optString("src_mac").isNotEmpty()) {
                blocked.put(JSONObject().put("section", k).put("mac", s.optString("src_mac"))
                    .put("label", s.optString("name", s.optString("src_mac"))))
            }
        }

        // Mark leases that are reserved or blocked
        val reservedMacs = mutableSetOf<String>()
        for (i in 0 until reservations.length()) reservedMacs.add(reservations.optJSONObject(i)?.optString("mac", "")?.lowercase() ?: "")
        val blockedMacs = mutableSetOf<String>()
        for (i in 0 until blocked.length()) blockedMacs.add(blocked.optJSONObject(i)?.optString("mac", "")?.lowercase() ?: "")
        for (i in 0 until leases.length()) {
            val lease = leases.optJSONObject(i) ?: continue
            val mac = lease.optString("mac", "").lowercase()
            if (reservedMacs.contains(mac)) lease.put("reserved", true)
            if (blockedMacs.contains(mac)) lease.put("blocked", true)
        }
        
        return ok(JSONObject().put("enabled", lanSec?.optString("ignore") != "1")
            .put("ipv6Enabled", false).put("routerIp", activeRouterIp).put("netmask", "255.255.255.0")
            .put("start", start).put("limit", limit)
            .put("rangeStart", rangeStart).put("rangeEnd", rangeEnd)
            .put("leasetime", lanSec?.optString("leasetime", "12h") ?: "12h")
            .put("dns", dnsArr).put("reservations", reservations)
            .put("leases", leases).put("leasesAvailable", leasesAvailable)
            .put("blocked", blocked)
            .put("managedElsewhere", false)
            .put("blocking", JSONObject().put("available", true).put("reason", JSONObject.NULL)))
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
        val mask = lanSec.optString("netmask", "255.255.255.0")
        val prefix = mask.split(".").sumOf { Integer.bitCount(it.toIntOrNull() ?: 0) }
        return ok(JSONObject().put("ip", lanSec.optString("ipaddr", activeRouterIp))
            .put("netmask", mask).put("prefix", prefix)
            .put("gateway", lanSec.optString("gateway", ""))
            .put("managedElsewhere", false))
    }

    private fun updateLan(body: JSONObject): Response {
        val values = JSONObject()
        if (body.has("ip")) values.put("ipaddr", body.getString("ip"))
        if (body.has("netmask")) values.put("netmask", body.getString("netmask"))
        uciSet("network", "lan", values)

        // Changing the router address moves this very page. Apply behind the rollback timer
        // and follow the router to the new IP; if it never answers there, we don't confirm
        // and the router restores its old address by itself — so a typo can't lock you out.
        val newIp = if (body.has("ip")) body.getString("ip") else ""
        val applied = commitWithRollback(listOf("network"),
            candidates = if (newIp.isNotEmpty()) listOf(newIp) else emptyList())
        if (!applied) {
            return err(Response.Status.INTERNAL_ERROR,
                "The router didn't answer at the new address, so it put the old one back.",
                "CHANGE_REVERTED")
        }
        return buildLan()
    }

    // ═══════════════════════════════════════════════════════════
    // IPv6
    // ═══════════════════════════════════════════════════════════
    /** Section key of the LAN dhcp block, e.g. "lan". Falls back to "lan". */
    private fun lanDhcpSectionKey(): String {
        val dhcpCfg = uciOf("dhcp")
        return dhcpCfg.keys().asSequence().firstOrNull { k ->
            dhcpCfg.optJSONObject(k)?.let { it.optString(".type") == "dhcp" && (it.optString("interface") == "lan" || it.optString(".name") == "lan") } == true
        } ?: "lan"
    }

    /**
     * Current IPv6 state. `enabled` reflects whether odhcpd serves IPv6 to the LAN
     * (dhcp.lan.ra/dhcpv6 set to "server"). `mode` is "global" when an upstream IPv6
     * interface (wan6/wwan6) exists, else "local" (router-generated ULA only), else "off".
     */
    private fun buildIpv6(): Response {
        val dhcpCfg = uciOf("dhcp")
        val lanSec = dhcpCfg.optJSONObject(lanDhcpSectionKey())
        val ra = lanSec?.optString("ra", "")?.lowercase() ?: ""
        val dhcpv6 = lanSec?.optString("dhcpv6", "")?.lowercase() ?: ""
        val enabled = ra == "server" || ra == "relay" || dhcpv6 == "server" || dhcpv6 == "relay"

        val networkCfg = uciOf("network")
        val hasUplink6 = networkCfg.keys().asSequence().any { k ->
            networkCfg.optJSONObject(k)?.optString("proto") == "dhcpv6"
        }
        val mode = when {
            !enabled -> "off"
            hasUplink6 -> "global"
            else -> "local"
        }
        val supported = firstRadioId() != null || networkCfg.length() > 0
        return ok(JSONObject().put("enabled", enabled).put("mode", mode)
            .put("supported", true)
            .put("description", when (mode) {
                "global" -> "IPv6 is on. Devices get internet IPv6 addresses from your provider."
                "local" -> "IPv6 is on. Your provider has no IPv6, so devices get router-local (ULA) addresses only."
                else -> "IPv6 is off. All devices use IPv4 only."
            }))
    }

    /**
     * Enable or disable IPv6. Enable: LAN serves RA + DHCPv6 (clients get ULA immediately,
     * or global addresses if an upstream IPv6 prefix is available), and a wan6 uplink is
     * created when a wan interface exists. Disable: fully revert to IPv4 — stop RA/DHCPv6,
     * turn off kernel IPv6 on LAN, and remove the wan6/wwan6 uplink so routing drops back
     * to IPv4 (this full revert is what was missing before). odhcpd is restarted either way
     * so the change takes effect without clients reconnecting.
     */
    private fun updateIpv6(body: JSONObject): Response {
        val enable = body.optBoolean("enabled", false)
        val lanKey = lanDhcpSectionKey()
        val networkCfg = uciOf("network")

        if (enable) {
            // Kernel IPv6 on the LAN interface, and odhcpd serving RA + DHCPv6 to clients.
            uciSet("network", "lan", JSONObject().put("ipv6", "1"))
            uciSet("dhcp", lanKey, JSONObject()
                .put("ra", "server").put("dhcpv6", "server").put("ndp", "disabled"))

            // Create an upstream IPv6 client on the wan device when a wan interface exists
            // (wired router mode). In AP/repeater mode there's no wan; ULA still works.
            val wan = networkCfg.optJSONObject("wan")
            if (wan != null) {
                val wanDevice = wan.optString("device", "").ifEmpty { wan.optString("ifname", "") }
                val values = JSONObject().put("proto", "dhcpv6")
                    .put("reqaddress", "try").put("reqprefix", "auto")
                if (wanDevice.isNotEmpty()) values.put("device", wanDevice) else values.put("device", "@wan")
                uciEnsure("network", "wan6", "interface", values)
                addToWanZone("wan6")
            }
        } else {
            // Full revert to IPv4: stop serving IPv6, drop kernel IPv6 on LAN, remove uplinks.
            uciSet("network", "lan", JSONObject().put("ipv6", "0"))
            uciSet("dhcp", lanKey, JSONObject()
                .put("ra", "disabled").put("dhcpv6", "disabled").put("ndp", "disabled"))
            // Remove any dhcpv6 uplink interfaces so the default route drops to IPv4.
            networkCfg.keys().asSequence().filter { k ->
                networkCfg.optJSONObject(k)?.optString("proto") == "dhcpv6"
            }.toList().forEach { k ->
                uciDelete("network", k)
                removeFromWanZone(k)
            }
        }

        // Apply behind the rollback timer. The IPv6 toggle never moves the router's own
        // address (LAN IPv4 is untouched), so no candidate IPs are needed. If applying it
        // somehow makes the router unreachable, commitWithRollback declines to confirm and
        // the router reverts to the pre-toggle state on its own.
        val applied = commitWithRollback(listOf("network", "dhcp", "firewall"))
        if (!applied) {
            return err(Response.Status.INTERNAL_ERROR,
                "The IPv6 change didn't stick, so the router put your previous settings back.",
                "CHANGE_REVERTED")
        }

        // Restart odhcpd so RA/DHCPv6 changes reach clients immediately (an unsolicited RA
        // is sent), and reload network so wan6 is picked up / torn down. Without this the
        // toggle appears to do nothing until clients reconnect.
        tryCall("file", "exec", JSONObject().put("command", "/etc/init.d/network").put("params", JSONArray().put("reload")))
        tryCall("file", "exec", JSONObject().put("command", "/etc/init.d/odhcpd").put("params", JSONArray().put("restart")))
        return buildIpv6()
    }

    /** Add [network] to the firewall "wan" zone's network list, if not already present. */
    private fun addToWanZone(network: String) {
        val firewall = uciOf("firewall")
        val zoneKey = firewall.keys().asSequence().firstOrNull { k ->
            firewall.optJSONObject(k)?.let { it.optString(".type") == "zone" && it.optString("name") == "wan" } == true
        } ?: return
        val zone = firewall.optJSONObject(zoneKey) ?: return
        val nets = mutableListOf<String>()
        when (val raw = zone.opt("network")) {
            is JSONArray -> for (i in 0 until raw.length()) nets.add(raw.optString(i))
            is String -> raw.split(" ").filter { it.isNotEmpty() }.forEach { nets.add(it) }
        }
        if (nets.isEmpty()) nets.add("wan")
        if (!nets.contains(network)) {
            nets.add(network)
            uciSet("firewall", zoneKey, JSONObject().put("network", JSONArray(nets)))
        }
    }

    /** Remove [network] from the firewall "wan" zone's network list, if present. */
    private fun removeFromWanZone(network: String) {
        val firewall = uciOf("firewall")
        val zoneKey = firewall.keys().asSequence().firstOrNull { k ->
            firewall.optJSONObject(k)?.let { it.optString(".type") == "zone" && it.optString("name") == "wan" } == true
        } ?: return
        val zone = firewall.optJSONObject(zoneKey) ?: return
        val nets = mutableListOf<String>()
        when (val raw = zone.opt("network")) {
            is JSONArray -> for (i in 0 until raw.length()) nets.add(raw.optString(i))
            is String -> raw.split(" ").filter { it.isNotEmpty() }.forEach { nets.add(it) }
        }
        if (nets.remove(network)) {
            uciSet("firewall", zoneKey, JSONObject().put("network", JSONArray(nets)))
        }
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
            // Router mode keeps the LAN address static, so the router stays reachable at the
            // same IP. Apply behind the rollback timer; if it somehow stops answering, the
            // change is not confirmed and the router restores the previous mode itself.
            val applied = commitWithRollback(listOf("wireless", "network", "dhcp"))
            if (!applied) return err(Response.Status.INTERNAL_ERROR,
                "The router didn't come back after switching to Router mode, so it restored your previous setup.",
                "CHANGE_REVERTED")
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
            // NOTE: AP mode deliberately does NOT use commitWithRollback. Switching to AP
            // turns the LAN into a DHCP client, so the router gets a new, unpredictable
            // address from the upstream router. A reconnect probe at the old IP would fail
            // even on a fully successful switch, which would wrongly trigger a rollback.
            // Until we can discover the new address reliably (mDNS/ARP scan), AP applies
            // directly. The router's own apply timer still isn't armed here.
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

            // The repeater keeps its own LAN address, so the app reconnects at the same IP
            // even while the STA is still associating upstream. Wi-Fi restarts during the
            // switch, so allow a longer settle before probing. If the router never answers
            // again, the rollback timer restores the previous mode on its own.
            val applied = commitWithRollback(listOf("wireless", "network", "dhcp"), settleMs = 6000)
            if (!applied) return err(Response.Status.INTERNAL_ERROR,
                "The router didn't come back after switching to Repeater mode, so it restored your previous setup.",
                "CHANGE_REVERTED")
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
            .put("capabilities", JSONObject()
                .put("wirelessControl", true)
                .put("iwinfo", true)
                .put("dhcpLeases", true)
                .put("fileRead", false)
                .put("cpuUsage", false)
                .put("sqm", false)
                .put("hostapdControl", false)))
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
    
    private fun buildRadioCapabilities(radioId: String, uciSection: JSONObject, band: String): JSONObject {
        // Try to find an actual interface name for this radio to query iwinfo
        val wirelessStatus = tryCall("network.wireless", "status") ?: JSONObject()
        val radioStatus = wirelessStatus.optJSONObject(radioId)
        var ifname: String? = null
        radioStatus?.optJSONArray("interfaces")?.let { ifaces ->
            for (i in 0 until ifaces.length()) {
                val n = ifaces.optJSONObject(i)?.optString("ifname", "")
                if (!n.isNullOrEmpty()) { ifname = n; break }
            }
        }

        // Get available channels from iwinfo freqlist
        val channels = JSONArray()
        if (ifname != null) {
            val freqList = tryCall("iwinfo", "freqlist", JSONObject().put("device", ifname))
            freqList?.optJSONArray("results")?.let { results ->
                for (i in 0 until results.length()) {
                    val entry = results.optJSONObject(i) ?: continue
                    val ch = entry.optInt("channel", 0)
                    if (ch > 0 && !entry.optBoolean("restricted", false)) {
                        channels.put(JSONObject().put("channel", ch)
                            .put("frequency", entry.optInt("mhz", 0))
                            .put("dfs", entry.optBoolean("dfs", false)))
                    }
                }
            }
        }

        // Build width options based on band
        val widthOptions = JSONArray()
        if (band.contains("5") || band.contains("6")) {
            widthOptions.put(JSONObject().put("width", 20).put("value", "VHT20").put("label", "20 MHz").put("standard", "802.11ac"))
            widthOptions.put(JSONObject().put("width", 40).put("value", "VHT40").put("label", "40 MHz").put("standard", "802.11ac"))
            widthOptions.put(JSONObject().put("width", 80).put("value", "VHT80").put("label", "80 MHz").put("standard", "802.11ac"))
            widthOptions.put(JSONObject().put("width", 160).put("value", "VHT160").put("label", "160 MHz").put("standard", "802.11ac"))
            // Add HE (Wi-Fi 6) options if available
            val htmode = uciSection.optString("htmode", "")
            if (htmode.startsWith("HE") || htmode.contains("AX") || uciSection.optString("band", "").contains("a")) {
                widthOptions.put(JSONObject().put("width", 80).put("value", "HE80").put("label", "80 MHz (Wi-Fi 6)").put("standard", "802.11ax"))
                widthOptions.put(JSONObject().put("width", 160).put("value", "HE160").put("label", "160 MHz (Wi-Fi 6)").put("standard", "802.11ax"))
            }
        } else {
            widthOptions.put(JSONObject().put("width", 20).put("value", "HT20").put("label", "20 MHz").put("standard", "802.11n"))
            widthOptions.put(JSONObject().put("width", 40).put("value", "HT40").put("label", "40 MHz").put("standard", "802.11n"))
        }

        val hasChannels = channels.length() > 0
        return JSONObject()
            .put("supports", JSONObject().put("channel", hasChannels).put("txpower", true))
            .put("channels", channels)
            .put("widthOptions", widthOptions)
            .put("txpower", JSONObject().put("min", 0).put("max", 30))
    }
    private fun bandFromSection(s: JSONObject): String {
        val band = s.optString("band", "")
        return when { band.contains("5") -> "5GHz"; band.contains("6") -> "6GHz"; else -> "2.4GHz" }
    }

    private fun firstRadioId(): String? {
        val wireless = uciOf("wireless")
        return wireless.keys().asSequence().firstOrNull { k -> wireless.optJSONObject(k)?.optString(".type") == "wifi-device" }
    }

    /**
     * MAC addresses currently associated to any AP interface, gathered straight from UCI
     * so it works even on firmware without network.wireless.status. Mirrors the ifname
     * resolution used by buildRadiosArray.
     */
    /**
     * Wi-Fi stations currently associated to any AP, keyed by lowercased MAC. Each value
     * carries signal, ssid, radio id and connected seconds. Works without
     * network.wireless.status by falling back to UCI-derived ifnames.
     */
    private fun collectWifiStations(): Map<String, JSONObject> {
        val stations = mutableMapOf<String, JSONObject>()

        // Helper: pull assoclist for a real ifname and record every associated MAC.
        fun harvest(ifname: String, ssid: String, radio: String) {
            if (ifname.isEmpty()) return
            val assoc = tryCall("iwinfo", "assoclist", JSONObject().put("device", ifname)) ?: return
            val results = assoc.optJSONArray("results") ?: return
            for (r in 0 until results.length()) {
                val e = results.optJSONObject(r) ?: continue
                val mac = e.optString("mac").lowercase()
                if (mac.isEmpty()) continue
                // Prefer the entry with a real signal; don't overwrite a good one with a blank.
                val existing = stations[mac]
                if (existing == null || existing.opt("signal") == null || existing.isNull("signal")) {
                    stations[mac] = JSONObject()
                        .put("signal", e.opt("signal"))
                        .put("ssid", ssid).put("radio", radio)
                        .put("connectedSeconds", e.opt("connected_time"))
                }
            }
        }

        // Primary: enumerate the router's actual Wi-Fi interfaces via iwinfo. This never
        // guesses ifnames, so it catches every radio's clients (fixes wireless clients on
        // a second radio being missed and mislabelled as wired).
        val devices = tryCall("iwinfo", "devices")?.optJSONArray("devices")
        if (devices != null) {
            for (i in 0 until devices.length()) {
                val ifname = devices.optString(i, "")
                if (ifname.isEmpty()) continue
                // Only harvest AP interfaces; skip our own STA uplink (its "client" is the
                // upstream AP, not a device on our network).
                val info = tryCall("iwinfo", "info", JSONObject().put("device", ifname))
                val infoMode = info?.optString("mode", "")?.lowercase() ?: ""
                if (infoMode.contains("client") || infoMode.contains("sta")) continue
                val ssid = info?.optString("ssid", "") ?: ""
                harvest(ifname, ssid, ifname)
            }
        }

        // Fallback / enrichment: walk UCI wifi-ifaces and resolve ifnames the old way.
        // Runs regardless so SSID/radio labels map to UCI radio ids, and so it still works
        // on firmware where `iwinfo devices` is unavailable.
        val wireless = uciOf("wireless")
        val netWireless = tryCall("network.wireless", "status") ?: JSONObject()
        wireless.keys().forEach { k ->
            val radio = wireless.optJSONObject(k) ?: return@forEach
            val rType = radio.optString(".type").ifEmpty { if (k.matches(Regex("radio\\d+"))) "wifi-device" else "wifi-iface" }
            if (rType != "wifi-device") return@forEach
            val netInterfaces = netWireless.optJSONObject(k)?.optJSONArray("interfaces") ?: JSONArray()
            var apIndex = 0
            wireless.keys().forEach { ik ->
                val iface = wireless.optJSONObject(ik) ?: return@forEach
                if (iface.optString(".type") != "wifi-iface" || iface.optString("device") != k) return@forEach
                val mode = iface.optString("mode", "ap")
                if (mode != "ap") return@forEach
                val ssid = iface.optString("ssid", "")
                var ifname = iface.optString("ifname", "")
                for (i in 0 until netInterfaces.length()) {
                    val cfg = netInterfaces.optJSONObject(i)?.optJSONObject("config") ?: continue
                    if (cfg.optString(".name") == ik || cfg.optString("ssid") == ssid) {
                        val nIf = netInterfaces.optJSONObject(i)?.optString("ifname", "") ?: ""
                        if (nIf.isNotEmpty()) ifname = nIf
                    }
                }
                if (ifname.isEmpty()) ifname = resolveIfname(k, mode, apIndex)
                apIndex++
                harvest(ifname, ssid, k)
            }
        }
        return stations
    }

    private fun collectWifiMacs(): Set<String> = collectWifiStations().keys

    /**
     * Merged view of connected devices, the way LuCI builds its client list: DHCP leases
     * (luci-rpc getDHCPLeases, else the leases file) for IP/hostname/expiry, host hints
     * (getHostHints) for names, and iwinfo assoclist for the wired/wireless split and
     * signal. Returns a JSONArray of device objects and whether any source was reachable.
     */
    private fun collectClients(): Pair<JSONArray, Boolean> {
        val cached = clientsCache
        if (cached != null && (System.currentTimeMillis() - clientsCacheAt) < clientsCacheTtlMs) {
            return cached
        }
        val fresh = collectClientsUncached()
        clientsCache = fresh
        clientsCacheAt = System.currentTimeMillis()
        return fresh
    }

    private fun collectClientsUncached(): Pair<JSONArray, Boolean> {
        val stations = collectWifiStations()
        // mac -> device object, so the same device from multiple sources merges.
        val byMac = linkedMapOf<String, JSONObject>()
        fun entryFor(mac: String): JSONObject = byMac.getOrPut(mac) {
            JSONObject().put("mac", mac).put("ip", JSONObject.NULL)
                .put("hostname", JSONObject.NULL).put("isWireless", stations.containsKey(mac))
        }
        var available = false

        // 1. Host hints: MAC -> {name, ipv4, ipv6}. Best source of friendly names.
        val hints = tryCall("luci-rpc", "getHostHints")
        if (hints != null) {
            available = true
            hints.keys().forEach { mac ->
                val h = hints.optJSONObject(mac) ?: return@forEach
                val m = mac.lowercase()
                val dev = entryFor(m)
                val name = h.optString("name", "").ifEmpty { null }
                if (name != null && dev.isNull("hostname")) dev.put("hostname", name)
                val ipv4 = h.optString("ipv4", "").ifEmpty { h.optJSONArray("ipaddrs")?.optString(0, "") ?: "" }
                if (ipv4.isNotEmpty() && dev.isNull("ip")) dev.put("ip", ipv4)
            }
        }

        // 2. DHCP leases: authoritative IP/hostname/expiry.
        val leaseArr = tryCall("luci-rpc", "getDHCPLeases")?.optJSONArray("dhcp_leases")
        if (leaseArr != null) {
            available = true
            for (i in 0 until leaseArr.length()) {
                val l = leaseArr.optJSONObject(i) ?: continue
                val mac = l.optString("macaddr").lowercase()
                if (mac.isEmpty()) continue
                val dev = entryFor(mac)
                val ip = l.optString("ipaddr", "")
                if (ip.isNotEmpty()) dev.put("ip", ip)
                val host = l.optString("hostname", "").ifEmpty { null }
                if (host != null) dev.put("hostname", host)
                val expires = l.optLong("expires", -1L)
                // luci-rpc reports seconds remaining; convert to an absolute epoch ms.
                dev.put("leaseExpiresAt", if (expires > 0) (System.currentTimeMillis() + expires * 1000) else JSONObject.NULL)
            }
        }

        // 3. File fallback when luci-rpc is unavailable (needs rpcd-mod-file).
        if (!available) {
            val leasesRes = tryCall("file", "read", JSONObject().put("path", "/tmp/dhcp.leases"))
            val arpRes = tryCall("file", "read", JSONObject().put("path", "/proc/net/arp"))
            if (leasesRes != null || arpRes != null) {
                available = true
                (leasesRes?.optString("data", "") ?: "").split("\n").forEach { line ->
                    val p = line.trim().split(" ")
                    if (p.size >= 4 && p[1] != "00:00:00:00:00:00") {
                        val dev = entryFor(p[1].lowercase())
                        dev.put("ip", p[2])
                        if (p[3] != "*") dev.put("hostname", p[3])
                        p[0].toLongOrNull()?.let { dev.put("leaseExpiresAt", it * 1000) }
                    }
                }
                (arpRes?.optString("data", "") ?: "").split("\n").drop(1).forEach { line ->
                    val p = line.trim().split(Regex("\\s+"))
                    if (p.size >= 4) {
                        val flags = p[2].toIntOrNull(16) ?: 0
                        val mac = p[3].lowercase()
                        if (mac != "00:00:00:00:00:00" && (flags and 0x2) != 0) {
                            val dev = entryFor(mac)
                            if (dev.isNull("ip")) dev.put("ip", p[0])
                        }
                    }
                }
            }
        }

        // 4. Ensure every associated Wi-Fi station shows even without a lease/hint.
        stations.forEach { (mac, st) ->
            available = true
            val dev = entryFor(mac)
            dev.put("isWireless", true)
            dev.put("signal", st.opt("signal"))
            dev.put("ssid", st.optString("ssid", ""))
            dev.put("connectedSeconds", st.opt("connectedSeconds"))
        }

        // Filter out devices that aren't ours. In repeater mode host hints and ARP carry
        // the upstream (main router) network too; keep only devices associated to our own
        // Wi-Fi AP, or whose IP sits inside our LAN subnet. Our own LAN gateway IP is dropped.
        val subnet = lanSubnet()
        val ownIp = (uciOf("network").optJSONObject("lan")?.optString("ipaddr", "")?.ifEmpty { null })
            ?: activeRouterIp

        // Normalise: fill the display IP, mark wired vs wireless.
        val out = JSONArray()
        byMac.values.forEach { dev ->
            val mac = dev.optString("mac")
            val isWireless = stations.containsKey(mac)
            val ip = if (dev.isNull("ip")) "" else dev.optString("ip", "")
            // Keep rule: our associated Wi-Fi station always; otherwise must be a real IP
            // inside our LAN subnet and not the router's own address.
            val keep = when {
                isWireless -> true
                subnet == null -> ip.isNotEmpty() // can't determine subnet: fall back to "has IP"
                ip.isEmpty() -> false
                ip == ownIp -> false
                else -> ipInSubnet(ip, subnet)
            }
            if (!keep) return@forEach
            dev.put("ip", if (ip.isEmpty()) "—" else ip)
            dev.put("isWireless", isWireless)
            out.put(dev)
        }
        return Pair(out, available)
    }

    /**
     * Best-effort runtime interface name for a wifi-iface when network.wireless.status
     * is unavailable. Tries the conventional OpenWrt names (phy0-ap0, wlan0, …) and the
     * radio id itself, returning the first that iwinfo recognises.
     */
    private fun resolveIfname(radioId: String, mode: String, apIndex: Int): String {
        val cacheKey = "$radioId|$mode|$apIndex"
        ifnameCache[cacheKey]?.let { return it }
        val idx = radioId.filter { it.isDigit() }.ifEmpty { "0" }
        val m = if (mode == "sta") "sta" else "ap"
        val n = if (mode == "sta") 0 else apIndex
        val candidates = listOf("phy$idx-$m$n", "phy$idx-${m}0", "wlan$idx", radioId)
        for (c in candidates) {
            val info = tryCall("iwinfo", "info", JSONObject().put("device", c))
            if (info != null && info.length() > 0) {
                ifnameCache[cacheKey] = c
                return c
            }
        }
        return candidates.first()
    }

    /**
     * Choose an interface on [radioId] to run an iwinfo scan on. Prefers an AP interface,
     * because a STA (client) interface — the band connected upstream in repeater mode — is
     * busy on its associated channel and cannot scan.
     *
     * Returns (ifname, staOnly): ifname is the interface to scan on (empty if none found);
     * staOnly is true when the radio has interfaces but they are all STA/client mode, i.e.
     * this band is dedicated to the uplink and scanning is not possible.
     */
    private fun resolveScanInterface(radioId: String): Pair<String, Boolean> {
        var apIface = ""
        var sawSta = false
        var sawAp = false

        // 1. Prefer live runtime info from network.wireless.status when available.
        val netWireless = tryCall("network.wireless", "status") ?: JSONObject()
        netWireless.optJSONObject(radioId)?.optJSONArray("interfaces")?.let { ifaces ->
            for (i in 0 until ifaces.length()) {
                val iface = ifaces.optJSONObject(i) ?: continue
                val mode = iface.optJSONObject("config")?.optString("mode", "")
                    ?: iface.optString("mode", "")
                val ifname = iface.optString("ifname", "")
                when (mode.lowercase()) {
                    "ap" -> { sawAp = true; if (apIface.isEmpty() && ifname.isNotEmpty()) apIface = ifname }
                    "sta", "client", "mesh" -> sawSta = true
                }
            }
        }

        // 2. Fall back to UCI wifi-ifaces when status didn't give us an AP ifname.
        if (apIface.isEmpty()) {
            val wireless = uciOf("wireless")
            var apIndex = 0
            wireless.keys().forEach { ik ->
                val iface = wireless.optJSONObject(ik) ?: return@forEach
                if (iface.optString(".type") != "wifi-iface" || iface.optString("device") != radioId) return@forEach
                val mode = iface.optString("mode", "ap")
                if (mode == "ap") {
                    sawAp = true
                    val if0 = iface.optString("ifname", "").ifEmpty { resolveIfname(radioId, "ap", apIndex) }
                    if (apIface.isEmpty() && if0.isNotEmpty()) apIface = if0
                    apIndex++
                } else {
                    sawSta = true
                }
            }
        }

        if (apIface.isNotEmpty()) return Pair(apIface, false)
        // No AP interface: if the only interfaces are STA, this band can't scan.
        if (sawSta && !sawAp) return Pair("", true)
        // No interfaces resolved at all — last resort, let iwinfo try the radio id.
        return Pair(radioId, false)
    }

    /**
     * Our LAN subnet as (networkInt, maskInt), read from UCI lan config. Used to drop
     * upstream/main-router devices from the client list when running as a repeater — in
     * that mode host hints and the ARP table also carry the upstream network's clients.
     * Returns null when the LAN address can't be determined (then no filtering is applied).
     */
    private fun lanSubnet(): Pair<Long, Long>? {
        val lan = uciOf("network").optJSONObject("lan")
        val ip = (lan?.optString("ipaddr", "")?.ifEmpty { null }) ?: activeRouterIp.ifEmpty { null } ?: return null
        val mask = lan?.optString("netmask", "")?.ifEmpty { null } ?: "255.255.255.0"
        val ipInt = ipToLong(ip) ?: return null
        val maskInt = ipToLong(mask) ?: return null
        return Pair(ipInt and maskInt, maskInt)
    }

    private fun ipToLong(ip: String): Long? {
        val parts = ip.trim().split(".")
        if (parts.size != 4) return null
        var out = 0L
        for (p in parts) {
            val n = p.toIntOrNull() ?: return null
            if (n < 0 || n > 255) return null
            out = (out shl 8) or n.toLong()
        }
        return out
    }

    private fun ipInSubnet(ip: String, subnet: Pair<Long, Long>): Boolean {
        val ipInt = ipToLong(ip) ?: return false
        return (ipInt and subnet.second) == subnet.first
    }

    private fun formatUptime(seconds: Long): String {
        if (seconds <= 0) return "—"
        val d = seconds / 86400; val h = (seconds % 86400) / 3600; val m = (seconds % 3600) / 60
        return when { d > 0 -> "${d}d ${h}h"; h > 0 -> "${h}h ${m}m"; else -> "${m}m" }
    }
}
