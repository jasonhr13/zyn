//go:build darwin

package security

import (
	"unsafe"

	"golang.org/x/sys/unix"
)

const (
	kernProc    = 14
	kernProcPID = 1
	pTraced     = 0x00000800
)

func debuggerAttached() (bool, string) {
	mib := [4]int32{unix.CTL_KERN, kernProc, kernProcPID, int32(unix.Getpid())}
	var info unix.KinfoProc
	size := uintptr(unsafe.Sizeof(info))

	_, _, errno := unix.Syscall6(
		unix.SYS___SYSCTL,
		uintptr(unsafe.Pointer(&mib[0])),
		4,
		uintptr(unsafe.Pointer(&info)),
		uintptr(unsafe.Pointer(&size)),
		0,
		0,
	)
	if errno != 0 {
		return false, ""
	}

	if info.Proc.P_flag&pTraced != 0 {
		return true, "process is being traced (P_TRACED)"
	}
	return false, ""
}
