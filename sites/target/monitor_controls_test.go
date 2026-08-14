package target

import (
	"testing"

	monitorhub "zynbot.app/engine/monitor-hub"
)

func TestTargetPingMeetsControls(t *testing.T) {
	tests := []struct {
		name           string
		ping           monitorhub.StockPing
		maxPrice       float64
		confirmedStock bool
		want           bool
	}{
		{name: "no controls accept unknown data", ping: monitorhub.StockPing{}, want: true},
		{name: "price at ceiling", ping: monitorhub.StockPing{Price: 34.99}, maxPrice: 34.99, want: true},
		{name: "price over ceiling", ping: monitorhub.StockPing{Price: 35}, maxPrice: 34.99, want: false},
		{name: "ceiling rejects unknown price", ping: monitorhub.StockPing{}, maxPrice: 34.99, want: false},
		{name: "confirmed stock accepts ten", ping: monitorhub.StockPing{StockLevel: 10}, confirmedStock: true, want: true},
		{name: "confirmed stock rejects nine", ping: monitorhub.StockPing{StockLevel: 9}, confirmedStock: true, want: false},
		{name: "confirmed stock rejects unknown", ping: monitorhub.StockPing{}, confirmedStock: true, want: false},
		{
			name:           "combined controls pass",
			ping:           monitorhub.StockPing{Price: 20, StockLevel: 12},
			maxPrice:       25,
			confirmedStock: true,
			want:           true,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := targetPingMeetsControls(test.ping, test.maxPrice, test.confirmedStock); got != test.want {
				t.Fatalf("targetPingMeetsControls() = %v, want %v", got, test.want)
			}
		})
	}
}
