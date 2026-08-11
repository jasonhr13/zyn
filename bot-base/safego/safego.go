package safego

import (
	"log"
	"runtime/debug"

	"zynbot.app/engine/bot-base/alert"
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
