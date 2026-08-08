package frontend

import (
	"log"
	"strconv"

	"github.com/PolarAIO/Polar-AIO/backend/bot-base/task"
	"github.com/PolarAIO/Polar-AIO/backend/bot-base/task/constants"
	monitorhub "github.com/PolarAIO/Polar-AIO/backend/monitor-hub"
)

func startMonitorMessageToInput(msg StartMonitorMessage) monitorhub.StartInput {
	delay, _ := strconv.Atoi(msg.MonitorDelay)
	items := make([]monitorhub.Item, 0, len(msg.Items))
	for _, it := range msg.Items {
		qty, _ := strconv.Atoi(it.Quantity)
		maxPrice, _ := strconv.ParseFloat(it.MaxPrice, 64)
		items = append(items, monitorhub.Item{
			MonitorInput: it.MonitorInput,
			Quantity:     qty,
			MaxPrice:     maxPrice,
		})
	}
	return monitorhub.StartInput{
		ID:           msg.Id,
		Site:         msg.Site,
		ProxyGroup:   msg.ProxyGroup,
		MonitorDelay: delay,
		Items:        items,
	}
}

func StartMonitor(msg StartMonitorMessage) {
	if !task.IsCloudConnected() {
		log.Printf("cloud disconnected: blocking start for monitor %s", msg.Id)
		_ = SendMessage(SentMessage{
			Type: "update-status",
			Messages: []any{
				map[string]any{
					"taskID": msg.Id,
					"status": "Cloud Disconnected",
					"color":  constants.Colors.RED,
				},
			},
		})
		return
	}
	monitorhub.Start(startMonitorMessageToInput(msg))
}
