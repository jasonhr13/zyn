package safego

import (
	"log"
	"runtime/debug"

	"github.com/PolarAIO/Polar-AIO/backend/bot-base/alert"
)

func Go(fn func()) {
	go func() {
		defer func() {
			if r := recover(); r != nil {
				stack := debug.Stack()
				log.Printf("panic in safego: %v\n%s", r, stack)
				alert.Panic("safego", r, stack)
			}
		}()
		fn()
	}()
}
