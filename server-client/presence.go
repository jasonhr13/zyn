package serverclient

import (
	"log"
	"time"

	"github.com/gorilla/websocket"
)

func SendPresence(payload []byte) error {
	serverConnMu.Lock()
	c := serverConn
	serverConnMu.Unlock()
	if c == nil {
		return nil
	}
	if err := writeConn(c, payload); err != nil {
		log.Printf("analytics: ws send presence: %v", err)
		return err
	}
	return nil
}

func CloseConnection() {
	serverConnMu.Lock()
	c := serverConn
	serverConn = nil
	serverConnMu.Unlock()
	if c == nil {
		return
	}
	serverWriteMu.Lock()
	_ = c.SetWriteDeadline(time.Now().Add(writeWait))
	_ = c.WriteMessage(
		websocket.CloseMessage,
		websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""),
	)
	serverWriteMu.Unlock()
	_ = c.Close()
}
