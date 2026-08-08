APP_NAME ?= polar-backend
BUILD_DIR ?= dist
FRONTEND_PORT ?= 8000

.PHONY: deps fmt test vet check build dev release

deps:
	go mod download

fmt:
	gofmt -w $$(rg --files -g '*.go')

test:
	go test ./...

vet:
	go vet ./...

check: test vet

build:
	mkdir -p $(BUILD_DIR)
	go build -trimpath -o $(BUILD_DIR)/$(APP_NAME) .

dev:
	go run . -dev -port $(FRONTEND_PORT)

release:
	./build.sh $(APP_NAME)
