package com.example.easymode

import android.content.Context
import fi.iki.elonen.NanoHTTPD
import java.io.IOException
import java.io.InputStream
import org.json.JSONArray
import org.json.JSONObject

class EasyModeServer(private val context: Context, port: Int) : NanoHTTPD(port) {
    private val ubus = UbusClient()
    private val defaultRouterIp = "192.168.1.1"

    override fun serve(session: IHTTPSession): Response {
        val uri = session.uri
        
        if (uri.startsWith("/api/")) {
            return handleApi(session)
        }
        
        var path = uri
        if (path == "/") path = "/index.html"
        if (path.startsWith("/")) path = path.substring(1)
        
        return try {
            val mimeType = getMimeTypeForFile(path)
            val assetStream: InputStream = context.assets.open("frontend/$path")
            newChunkedResponse(Response.Status.OK, mimeType, assetStream)
        } catch (e: IOException) {
            newFixedLengthResponse(Response.Status.NOT_FOUND, MIME_PLAINTEXT, "File Not Found")
        }
    }

    private fun handleApi(session: IHTTPSession): Response {
        val uri = session.uri
        val method = session.method

        val body = HashMap<String, String>()
        if (method == Method.POST || method == Method.PUT) {
            try { session.parseBody(body) } catch (e: Exception) {}
        }
        val postData = body["postData"] ?: "{}"
        
        // Simple authentication check
        val sid = session.cookies.read("sysauth_http")
        if (uri != "/api/auth/login" && sid.isNullOrEmpty()) {
            return newFixedLengthResponse(Response.Status.UNAUTHORIZED, "application/json", "{\"error\":\"Unauthorized\"}")
        }

        try {
            val uci = UciClient(ubus, defaultRouterIp, sid ?: "")

            when (uri) {
                "/api/auth/login" -> {
                    val json = JSONObject(postData)
                    val result = ubus.call(
                        defaultRouterIp, "00000000000000000000000000000000", "session", "login",
                        JSONObject().put("username", "root").put("password", json.optString("password", ""))
                    )
                    val newSid = result.getString("ubus_rpc_session")
                    val response = newFixedLengthResponse(Response.Status.OK, "application/json", "{}")
                    response.addHeader("Set-Cookie", "sysauth_http=$newSid; Path=/; HttpOnly")
                    return response
                }
                
                "/api/auth/logout" -> {
                    ubus.call(defaultRouterIp, sid ?: "", "session", "destroy")
                    val response = newFixedLengthResponse(Response.Status.OK, "application/json", "{}")
                    response.addHeader("Set-Cookie", "sysauth_http=; Path=/; Max-Age=0")
                    return response
                }
                
                "/api/status" -> {
                    val board = ubus.call(defaultRouterIp, sid!!, "system", "board")
                    val res = JSONObject()
                        .put("authenticated", true)
                        .put("hostname", board.optString("hostname", "OpenWrt"))
                        .put("model", board.optString("model", "Router"))
                        .put("system", board.optString("release", ""))
                    return newFixedLengthResponse(Response.Status.OK, "application/json", res.toString())
                }
                
                "/api/status/network" -> {
                    // Quick mock network state for now
                    val res = JSONObject()
                    res.put("internet", JSONObject().put("connected", true).put("ip", "192.168.1.100").put("uptime", 3600))
                    res.put("wan", JSONObject().put("up", true).put("kind", "ethernet").put("ip", "192.168.1.100").put("proto", "dhcp"))
                    res.put("lan", JSONObject().put("ip", defaultRouterIp))
                    res.put("ethernet", JSONArray())
                    return newFixedLengthResponse(Response.Status.OK, "application/json", res.toString())
                }
                
                "/api/status/mode" -> {
                    // Quick mock mode state (detect if repeater by checking uci wireless)
                    val wireless = uci.get("wireless")
                    var isRepeater = false
                    wireless.keys().forEach { key ->
                        val section = wireless.optJSONObject(key)
                        if (section?.optString("mode") == "sta") isRepeater = true
                    }
                    
                    val res = JSONObject()
                    res.put("id", if (isRepeater) "repeater" else "router")
                    res.put("title", if (isRepeater) "Wi-Fi Repeater" else "Router")
                    res.put("internetSource", if (isRepeater) "Wireless Uplink" else "Ethernet WAN")
                    res.put("repeaterPaused", false)
                    return newFixedLengthResponse(Response.Status.OK, "application/json", res.toString())
                }
                
                "/api/dhcp" -> {
                    val res = JSONObject()
                    res.put("enabled", true)
                    res.put("ipv6Enabled", false)
                    res.put("routerIp", defaultRouterIp)
                    res.put("netmask", "255.255.255.0")
                    res.put("start", 100)
                    res.put("limit", 150)
                    res.put("leasetime", "12h")
                    res.put("dns", JSONArray())
                    res.put("reservations", JSONArray())
                    res.put("blocked", JSONArray())
                    return newFixedLengthResponse(Response.Status.OK, "application/json", res.toString())
                }
                
                "/api/wifi" -> {
                    val res = JSONObject()
                    res.put("radios", JSONArray())
                    res.put("networks", JSONArray())
                    res.put("schedule", JSONObject().put("enabled", false))
                    res.put("stationCount", 0)
                    return newFixedLengthResponse(Response.Status.OK, "application/json", res.toString())
                }
                
                else -> {
                    val json = JSONObject().put("message", "API Endpoint $uri Not Implemented Yet in Native App")
                    return newFixedLengthResponse(Response.Status.OK, "application/json", json.toString())
                }
            }
        } catch (e: Exception) {
            val err = JSONObject().put("error", e.message ?: "Unknown error")
            return newFixedLengthResponse(Response.Status.UNAUTHORIZED, "application/json", err.toString())
        }
    }
}
