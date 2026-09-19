package com.example.easymode

import android.content.Context
import android.net.wifi.WifiManager
import fi.iki.elonen.NanoHTTPD
import java.io.IOException
import java.io.InputStream
import org.json.JSONArray
import org.json.JSONObject

class EasyModeServer(private val context: Context, port: Int) : NanoHTTPD(port) {
    private val ubus = UbusClient()
    private var activeRouterIp = "192.168.1.1"

    private fun getGatewayIp(): String {
        try {
            val wifiManager = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            val dhcpInfo = wifiManager.dhcpInfo
            val gateway = dhcpInfo.gateway
            if (gateway != 0) {
                val ipBytes = ByteArray(4)
                ipBytes[0] = (gateway and 0xFF).toByte()
                ipBytes[1] = ((gateway shr 8) and 0xFF).toByte()
                ipBytes[2] = ((gateway shr 16) and 0xFF).toByte()
                ipBytes[3] = ((gateway shr 24) and 0xFF).toByte()
                return java.net.InetAddress.getByAddress(ipBytes).hostAddress ?: "192.168.1.1"
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }
        return "192.168.1.1"
    }

    private fun formatError(msg: String): String {
        return JSONObject().put("error", JSONObject().put("message", msg)).toString()
    }

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
        
        val sid = session.cookies.read("sysauth_http")
        if (uri != "/api/auth/login" && uri != "/api/auth/config" && sid.isNullOrEmpty()) {
            return newFixedLengthResponse(Response.Status.UNAUTHORIZED, "application/json", formatError("Unauthorized"))
        }

        try {
            val uci = UciClient(ubus, activeRouterIp, sid ?: "")

            when (uri) {
                "/api/auth/config" -> {
                    val config = JSONObject()
                    config.put("defaultRouterHost", getGatewayIp())
                    config.put("demoAvailable", false)
                    return newFixedLengthResponse(Response.Status.OK, "application/json", config.toString())
                }

                "/api/auth/login" -> {
                    val json = JSONObject(postData)
                    val host = json.optString("host", getGatewayIp())
                    activeRouterIp = host // save for subsequent calls

                    val result = ubus.call(
                        host, "00000000000000000000000000000000", "session", "login",
                        JSONObject().put("username", "root").put("password", json.optString("password", ""))
                    )
                    val newSid = result.getString("ubus_rpc_session")
                    val response = newFixedLengthResponse(Response.Status.OK, "application/json", "{}")
                    response.addHeader("Set-Cookie", "sysauth_http=$newSid; Path=/; HttpOnly")
                    return response
                }
                
                "/api/auth/logout" -> {
                    ubus.call(activeRouterIp, sid ?: "", "session", "destroy")
                    val response = newFixedLengthResponse(Response.Status.OK, "application/json", "{}")
                    response.addHeader("Set-Cookie", "sysauth_http=; Path=/; Max-Age=0")
                    return response
                }
                
                "/api/status" -> {
                    val board = ubus.call(activeRouterIp, sid!!, "system", "board")
                    val res = JSONObject()
                        .put("authenticated", true)
                        .put("hostname", board.optString("hostname", "OpenWrt"))
                        .put("model", board.optString("model", "Router"))
                        .put("system", board.optString("release", ""))
                    return newFixedLengthResponse(Response.Status.OK, "application/json", res.toString())
                }
                
                "/api/status/network" -> {
                    val res = JSONObject()
                    res.put("internet", JSONObject().put("connected", true).put("ip", activeRouterIp).put("uptime", 3600))
                    res.put("wan", JSONObject().put("up", true).put("kind", "ethernet").put("ip", activeRouterIp).put("proto", "dhcp"))
                    res.put("lan", JSONObject().put("ip", activeRouterIp))
                    res.put("ethernet", JSONArray())
                    return newFixedLengthResponse(Response.Status.OK, "application/json", res.toString())
                }
                
                "/api/status/mode" -> {
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
                    res.put("routerIp", activeRouterIp)
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
                    return newFixedLengthResponse(Response.Status.NOT_FOUND, "application/json", formatError("API Endpoint $uri Not Implemented Yet in Native App"))
                }
            }
        } catch (e: Exception) {
            return newFixedLengthResponse(Response.Status.BAD_REQUEST, "application/json", formatError(e.message ?: "Unknown error"))
        }
    }
}
