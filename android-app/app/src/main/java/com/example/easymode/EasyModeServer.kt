package com.example.easymode

import android.content.Context
import fi.iki.elonen.NanoHTTPD
import java.io.IOException
import java.io.InputStream
import org.json.JSONObject

class EasyModeServer(private val context: Context, port: Int) : NanoHTTPD(port) {
    private val ubus = UbusClient()
    private val defaultRouterIp = "192.168.1.1" // Fallback to 192.168.1.1, same as PC version

    override fun serve(session: IHTTPSession): Response {
        val uri = session.uri
        
        // Route API calls to Kotlin logic
        if (uri.startsWith("/api/")) {
            return handleApi(session)
        }
        
        // Serve static frontend files
        var path = uri
        if (path == "/") {
            path = "/index.html"
        }
        
        // Remove leading slash
        if (path.startsWith("/")) {
            path = path.substring(1)
        }
        
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
            try {
                session.parseBody(body)
            } catch (e: Exception) {
                e.printStackTrace()
            }
        }
        val postData = body["postData"] ?: "{}"

        try {
            if (uri == "/api/auth/login" && method == Method.POST) {
                val json = JSONObject(postData)
                val pwd = json.optString("password", "")
                
                val result = ubus.call(
                    routerIp = defaultRouterIp,
                    session = "00000000000000000000000000000000",
                    obj = "session",
                    method = "login",
                    args = JSONObject().put("username", "root").put("password", pwd)
                )
                
                val sid = result.getString("ubus_rpc_session")
                val response = newFixedLengthResponse(Response.Status.OK, "application/json", "{}")
                response.addHeader("Set-Cookie", "sysauth_http=$sid; Path=/; HttpOnly")
                return response
            }
            
            if (uri == "/api/status" && method == Method.GET) {
                val cookies = session.cookies
                val sid = cookies.read("sysauth_http") ?: throw Exception("Unauthorized")
                
                val board = ubus.call(defaultRouterIp, sid, "system", "board")
                val res = JSONObject()
                res.put("authenticated", true)
                res.put("hostname", board.optString("hostname", "OpenWrt"))
                res.put("model", board.optString("model", "Router"))
                res.put("system", board.optString("release", ""))
                return newFixedLengthResponse(Response.Status.OK, "application/json", res.toString())
            }
            
            // Fallback for not-yet-implemented endpoints
            val json = JSONObject()
            json.put("message", "API Endpoint $uri Not Implemented Yet in Native App")
            return newFixedLengthResponse(Response.Status.OK, "application/json", json.toString())

        } catch (e: Exception) {
            val err = JSONObject().put("error", e.message ?: "Unknown error")
            return newFixedLengthResponse(Response.Status.UNAUTHORIZED, "application/json", err.toString())
        }
    }
}
