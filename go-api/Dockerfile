FROM golang:1.27-alpine AS build
WORKDIR /src/go-api
COPY go-api/go.mod go-api/go.sum ./
RUN go mod download
COPY go-api/ ./
COPY shared/queries.json /src/shared/queries.json
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /api .
FROM alpine:3.23
WORKDIR /app
RUN adduser -D -u 10001 app
COPY --from=build /api /app/api
COPY shared/queries.json /app/queries.json
USER app
EXPOSE 8080
CMD ["/app/api"]
