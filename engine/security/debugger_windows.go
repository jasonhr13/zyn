//go:build windows

package security

import "golang.org/x/sys/windows"

var procIsDebuggerPresent = windows.NewLazySystemDLL("kernel32.dll").NewProc("IsDebuggerPresent")

func debuggerAttached() (bool, string) {
	ret, _, _ := procIsDebuggerPresent.Call()
	if ret != 0 {
		return true, "IsDebuggerPresent"
	}
	return false, ""
}
