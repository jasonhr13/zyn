package frontend

import "testing"

func TestNormalizeStockPing(t *testing.T) {
	ping, ok := normalizeStockPing(StockPingMessage{
		Site:       "target",
		ProductKey: " 12345 ",
		Name:       "Product",
		Price:      12.99,
		StockLevel: 4,
		InStock:    true,
		From:       "discord-monitor",
	})
	if !ok {
		t.Fatal("valid ping rejected")
	}
	if ping.Site != "Target" || ping.ProductKey != "12345" || !ping.InStock || ping.At.IsZero() {
		t.Fatalf("normalized ping = %#v", ping)
	}
	if _, ok := normalizeStockPing(StockPingMessage{Site: "Target"}); ok {
		t.Fatal("ping without product key accepted")
	}
}
