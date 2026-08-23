package serverclient

import (
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"zynbot.app/engine/analytics"
	"zynbot.app/engine/bot-base/safego"
	"zynbot.app/engine/bot-base/siteconfig"
	"zynbot.app/engine/bot-base/task"
	"zynbot.app/engine/frontend"
	monitorhub "zynbot.app/engine/monitor-hub"
)

const (
	pongWait   = 60 * time.Second
	pingPeriod = 30 * time.Second
	writeWait  = 10 * time.Second
)

var serverURL = "wss://polar-wss-production.up.railway.app"

func SetServerURL(rawURL string) error {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return err
	}
	if parsed.Scheme != "ws" && parsed.Scheme != "wss" {
		return fmt.Errorf("expected ws or wss URL")
	}
	if parsed.Host == "" {
		return fmt.Errorf("missing host")
	}
	serverURL = strings.TrimRight(rawURL, "/")
	return nil
}

var (
	serverConn    *websocket.Conn
	serverConnMu  sync.Mutex
	serverWriteMu sync.Mutex
)

var serverDialer = &websocket.Dialer{
	Proxy:            nil,
	HandshakeTimeout: 45 * time.Second,
	NetDialContext:   (&net.Dialer{Timeout: 10 * time.Second}).DialContext,
}

func ConnectToServer(key *string) {
	initEventQueue()
	siteconfig.SetLicenseKey(*key)
	for {
		c, resp, err := serverDialer.Dial(fmt.Sprintf("%s?key=%s&version=%s", serverURL, *key, url.QueryEscape(analytics.Version)), nil)
		if err != nil {
			if resp != nil && resp.StatusCode == http.StatusUnauthorized {
				log.Printf("ws: unauthorized (401), will keep retrying")
			} else {
				log.Printf("ws: dial error: %v", err)
			}
			time.Sleep(3 * time.Second)
			continue
		}
		log.Printf("Connected To Server: %s", *key)

		_ = c.SetReadDeadline(time.Now().Add(pongWait))
		c.SetPongHandler(func(string) error {
			_ = c.SetReadDeadline(time.Now().Add(pongWait))
			return nil
		})

		done := make(chan struct{})
		safego.Go(func() { pingLoop(c, done) })

		setServerConn(c)
		readMessage(c)
		close(done)
		setServerConn(nil)
		_ = c.Close()
		time.Sleep(3 * time.Second)
	}
}

func pingLoop(c *websocket.Conn, done <-chan struct{}) {
	ticker := time.NewTicker(pingPeriod)
	defer ticker.Stop()
	for {
		select {
		case <-done:
			return
		case <-ticker.C:
			serverWriteMu.Lock()
			err := c.WriteControl(websocket.PingMessage, nil, time.Now().Add(writeWait))
			serverWriteMu.Unlock()
			if err != nil {
				_ = c.Close()
				return
			}
		}
	}
}

func setServerConn(c *websocket.Conn) {
	serverConnMu.Lock()
	serverConn = c
	serverConnMu.Unlock()
	if c != nil {
		flushPendingEvents()
	}
}

func IsConnected() bool {
	serverConnMu.Lock()
	defer serverConnMu.Unlock()
	return serverConn != nil
}

func flushPendingEvents() {
	queued := snapshotDurableEvents()
	if len(queued) == 0 {
		return
	}

	log.Printf("server-event flush: sending %d queued event(s)", len(queued))
	for _, item := range queued {
		if err := trySendPayload(item.Payload); err != nil {
			log.Printf("ws: flush event id=%s: %v (will retry on reconnect)", item.ID, err)
			return
		}
		log.Printf("server-event resent id=%s (awaiting ack)", item.ID)
	}
}

func trySendPayload(payload []byte) error {
	serverConnMu.Lock()
	c := serverConn
	serverConnMu.Unlock()
	if c == nil {
		return fmt.Errorf("websocket not connected")
	}
	return writeConn(c, payload)
}

func writeConn(c *websocket.Conn, payload []byte) error {
	encoded, err := encodeWireMessage(payload)
	if err != nil {
		return err
	}

	serverWriteMu.Lock()
	defer serverWriteMu.Unlock()
	_ = c.SetWriteDeadline(time.Now().Add(writeWait))
	if err := c.WriteMessage(websocket.BinaryMessage, encoded); err != nil {
		_ = c.Close()
		return err
	}
	return nil
}

func SendEvent(data task.ServerEventData) {
	eventID := newEventID()
	msg := ServerEventMessage{
		Type:            "event",
		EventID:         eventID,
		EventType:       data.EventType,
		ProductName:     data.ProductName,
		ProductPrice:    data.ProductPrice,
		OrderNumber:     data.OrderNumber,
		ProductQuantity: data.ProductQuantity,
		ProductImage:    data.ProductImage,
		Site:            data.Site,
		Size:            data.Size,
		TaskID:          data.TaskID,
		Timestamp:       time.Now().UnixMilli(),
		ProfileName:     data.ProfileName,
		ProxyGroup:      data.ProxyGroup,
	}

	payload, err := json.Marshal(msg)
	if err != nil {
		log.Printf("server-event persist failed: marshal error (event_type=%q, task_id=%q): %v", data.EventType, data.TaskID, err)
		return
	}

	// Persist first so a crash/disconnect can never lose the event.
	enqueueDurableEvent(eventID, payload)

	if err := trySendPayload(payload); err != nil {
		log.Printf("server-event deferred id=%s: %v", eventID, err)
		return
	}
	log.Printf("server-event sent id=%s event_type=%q task_id=%q product=%q (awaiting ack)", eventID, msg.EventType, msg.TaskID, msg.ProductName)
}

func SendStockPing(ping monitorhub.StockPing) {
	if ping.Site == "" || ping.ProductKey == "" {
		return
	}
	serverConnMu.Lock()
	c := serverConn
	serverConnMu.Unlock()
	if c == nil {
		return
	}

	inStock := ping.InStock
	data := map[string]any{
		"site":    ping.Site,
		"tcin":    ping.ProductKey,
		"instock": inStock,
	}
	if inStock {
		data["title"] = ping.Name
		data["image"] = ping.Image
		data["price"] = ping.Price
		if ping.StockLevel > 0 {
			data["totalstock"] = strconv.Itoa(ping.StockLevel)
		}
		if ping.Quantity > 0 {
			data["cartlimit"] = strconv.Itoa(ping.Quantity)
		}
		if ping.QueueId != "" {
			data["queueId"] = ping.QueueId
		}
		if ping.OfferId != "" {
			data["offerId"] = ping.OfferId
		}
	}

	payload, err := json.Marshal(map[string]any{"type": "stock-ping", "data": data})
	if err != nil {
		return
	}
	_ = writeConn(c, payload)
}

func readMessage(conn *websocket.Conn) {
	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			log.Printf("ws: read error: %v", err)
			return
		}

		data, err := decodeWireMessage(raw)
		if err != nil {
			log.Printf("ws: decode error: %v", err)
			continue
		}

		var msg ServerMessage
		if err := json.Unmarshal(data, &msg); err != nil {
			log.Printf("ws: json error: %v", err)
			continue
		}

		switch msg.Type {
		case "event-ack":
			var ack struct {
				EventID string `json:"event-id"`
			}
			if err := json.Unmarshal(msg.Data, &ack); err != nil {
				log.Printf("ws: event-ack decode error: %v", err)
				continue
			}
			ackDurableEvent(ack.EventID)
		case "userData":
			var userInfo struct {
				DiscordUsername string `json:"discord_username"`
				WhopUsername    string `json:"whop_username"`
			}
			if err := json.Unmarshal(msg.Data, &userInfo); err == nil {
				if userInfo.DiscordUsername != "" {
					siteconfig.SetUsername(userInfo.DiscordUsername)
				} else if userInfo.WhopUsername != "" {
					siteconfig.SetUsername(userInfo.WhopUsername)
				}
			}
			if err := frontend.SendMessage(FrontendUserDataMessage{
				Type: "userData",
				Data: msg.Data,
			}); err != nil {
				log.Printf("ws: forward userData: %v", err)
			}
		case "siteConfigs":
			var cfg siteconfig.Config
			if err := json.Unmarshal(msg.Data, &cfg); err != nil {
				log.Println("Failed to Parse Site Data")
				continue
			}
			siteconfig.Set(cfg)
			log.Printf("ws: siteConfigs applied luca=%v hyper=%v sites=%d",
				siteconfig.LucaAPIKey() != "", siteconfig.HyperAPIKey() != "", len(cfg.Sites))
		case "cloud-ping":
			monitorhub.HandleCloudPing(msg.Data)
		case "zephyr-ping":
			monitorhub.HandleZephyrPing(msg.Data)
		default:
			fmt.Println("unknown type:", msg.Type)
			fmt.Println(string(msg.Data))
		}
	}
}
