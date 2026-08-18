package target

import "testing"

func TestClipLog(t *testing.T) {
	if got := clipLog("abcd", 4); got != "abcd" {
		t.Fatalf("short clip = %q", got)
	}
	if got := clipLog("abcdef", 4); got != "abcd…" {
		t.Fatalf("long clip = %q", got)
	}
}

func TestAddressFieldLogQuotesSpaces(t *testing.T) {
	got := addressFieldLog("profile", "6960 Oakkmont Driv ", "Santa Rosa", "Margaret", "Mulhall")
	if want := `profile line1="6960 Oakkmont Driv " city="Santa Rosa" first="Margaret" last="Mulhall"`; got != want {
		t.Fatalf("got %s", got)
	}
}
