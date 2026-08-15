package security

var SuspiciousProcessNames = []string{
	"frida",
	"frida-server",
	"frida-helper",
	"frida-agent",
	"objection",
	"gdb",
	"lldb",
	"x64dbg",
	"x32dbg",
	"ollydbg",
	"ida64",
	"ghidra",
	"processhacker",
	"wireshark",
	"charles",
	"mitmproxy",
	"burpsuite",
	"hopper",
	"radare",
	"r2 ",
	"dnspy",
	"ilspy",
	"proxyman",
	"powhttp",
}

var FridaDefaultPorts = []int{27042, 27043, 27044, 27045}

var FridaArtifactPaths = []string{
	"/usr/local/bin/frida-server",
	"/usr/local/bin/frida",
	"/opt/frida/frida-server",
	"/Library/LaunchDaemons/re.frida.server.plist",
	"/private/var/tmp/re.frida.server",
}

var SuspiciousEnvVars = []string{
	"FRIDA_COMPILE",
	"FRIDA_SERVER",
	"DYLD_INSERT_LIBRARIES",
	"LD_PRELOAD",
	"DYLD_FORCE_FLAT_NAMESPACE",
}
