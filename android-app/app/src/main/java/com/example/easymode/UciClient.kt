package com.example.easymode

import org.json.JSONObject

class UciClient(private val ubus: UbusClient, private val routerIp: String, private val sid: String) {

    fun get(config: String): JSONObject {
        try {
            val result = ubus.call(routerIp, sid, "uci", "get", JSONObject().put("config", config))
            return result.optJSONObject("values") ?: JSONObject()
        } catch (e: Exception) {
            return JSONObject()
        }
    }

    fun state(config: String): JSONObject {
        try {
            val result = ubus.call(routerIp, sid, "uci", "state", JSONObject().put("config", config))
            return result.optJSONObject("values") ?: JSONObject()
        } catch (e: Exception) {
            return JSONObject()
        }
    }
}
