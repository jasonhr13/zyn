package app.zynbot.mobile.harvester

import android.app.ActivityManager
import android.app.Application
import android.app.Service
import android.content.Context
import android.os.Build

object HarvestProcesses {
  const val MAX_WORKERS = 6

  fun isWorker(context: Context): Boolean {
    return Regex(":h[0-5]$").containsMatchIn(processName(context))
  }

  fun processName(context: Context): String {
    if (Build.VERSION.SDK_INT >= 28) return Application.getProcessName()
    val pid = android.os.Process.myPid()
    val manager = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
    return manager.runningAppProcesses?.firstOrNull { it.pid == pid }?.processName.orEmpty()
  }

  fun serviceClass(index: Int): Class<out Service> {
    return when (index.coerceIn(0, MAX_WORKERS - 1)) {
      0 -> HarvestWorkerService0::class.java
      1 -> HarvestWorkerService1::class.java
      2 -> HarvestWorkerService2::class.java
      3 -> HarvestWorkerService3::class.java
      4 -> HarvestWorkerService4::class.java
      else -> HarvestWorkerService5::class.java
    }
  }

  fun shard(lines: List<String>, index: Int, total: Int): List<String> {
    if (lines.isEmpty() || total <= 1) return lines
    val shard = lines.filterIndexed { i, _ -> i % total == index }
    if (shard.isNotEmpty()) return shard
    return listOf(lines[index % lines.size])
  }
}
