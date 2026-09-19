package com.example.easymode

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class UbusClient {
    private val client = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(8, TimeUnit.SECONDS)
        .build()
        
    private val JSON = "application/json; charset=utf-8".toMediaType()

    fun call(routerIp: String, session: String, obj: String, method: String, args: JSONObject? = null): JSONObject {
        val reqBody = JSONObject().apply {
            put("jsonrpc", "2.0")
            put("id", 1)
            put("method", "call")
            put("params", JSONArray().apply {
                put(session)
                put(obj)
                put(method)
                put(args ?: JSONObject())
            })
        }

        val request = Request.Builder()
            .url("http://$routerIp/ubus")
            .post(reqBody.toString().toRequestBody(JSON))
            .build()

        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw Exception("HTTP Error: ${response.code}")
            val bodyStr = response.body?.string() ?: "{}"
            val json = JSONObject(bodyStr)
            
            if (json.has("error")) {
                throw Exception("RPC Error: " + json.optString("error"))
            }

            val resultArr = json.optJSONArray("result")
            val code = resultArr?.optInt(0, -1) ?: -1
            if (code != 0) throw Exception("Ubus Code: $code")
            
            return if ((resultArr?.length() ?: 0) > 1) {
                resultArr?.optJSONObject(1) ?: JSONObject()
            } else {
                JSONObject()
            }
        }
    }
}
