package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"strconv"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const maxInt32 = 1<<31 - 1

type product struct {
	ID         int32  `json:"id"`
	TenantID   int32  `json:"tenant_id"`
	CategoryID int32  `json:"category_id"`
	Name       string `json:"name"`
	PriceCents int32  `json:"price_cents"`
	Stock      int32  `json:"stock"`
}

type reservation struct {
	ProductID int32 `json:"product_id"`
	Available int32 `json:"available"`
}

type queries struct {
	Product string `json:"product"`
	List    string `json:"list"`
	Reserve string `json:"reserve"`
}

type api struct {
	pool    *pgxpool.Pool
	queries queries
}

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--version" {
		fmt.Println(runtime.Version())
		return
	}
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	sql, err := loadQueries()
	if err != nil {
		return err
	}
	poolSize, ok := parseInt(envOr("DB_POOL_SIZE", "32"), 1, 64)
	if !ok {
		return errors.New("DB_POOL_SIZE must be 1..64")
	}

	config, err := pgxpool.ParseConfig(os.Getenv("DATABASE_URL"))
	if err != nil {
		return err
	}
	// Fixed-size pool: connections are opened once and never recycled mid-run.
	config.MaxConns = int32(poolSize)
	config.MinConns = int32(poolSize)
	config.MaxConnLifetime = 0
	config.MaxConnIdleTime = 0
	config.ConnConfig.RuntimeParams["statement_timeout"] = "5000"
	config.ConnConfig.RuntimeParams["application_name"] = "go-api"

	pool, err := pgxpool.NewWithConfig(context.Background(), config)
	if err != nil {
		return err
	}
	defer pool.Close()
	if err := pool.Ping(context.Background()); err != nil {
		return err
	}

	a := &api{pool: pool, queries: sql}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", a.health)
	mux.HandleFunc("GET /ready", a.ready)
	mux.HandleFunc("GET /products/{id}", a.getProduct)
	mux.HandleFunc("GET /products", a.listProducts)
	mux.HandleFunc("POST /inventory/{id}/reserve", a.reserve)
	mux.HandleFunc("/", notFound)

	port := envOr("PORT", "8080")
	server := &http.Server{
		Addr:              ":" + port,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    8192,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
	}()

	log.Printf("listening on %s, pool=%d", port, poolSize)
	if err := server.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

func (a *api) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (a *api) ready(w http.ResponseWriter, r *http.Request) {
	if err := a.pool.Ping(r.Context()); err != nil {
		writeError(w, http.StatusServiceUnavailable, "database unavailable")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (a *api) getProduct(w http.ResponseWriter, r *http.Request) {
	id, ok := parseInt(r.PathValue("id"), 1, maxInt32)
	if !ok {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}

	var p product
	err := scanProduct(a.pool.QueryRow(r.Context(), a.queries.Product, id), &p)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		writeError(w, http.StatusNotFound, "not found")
	case err != nil:
		writeError(w, http.StatusServiceUnavailable, "database unavailable")
	default:
		writeJSON(w, http.StatusOK, p)
	}
}

func (a *api) listProducts(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	tenant, tenantOK := parseInt(query.Get("tenant_id"), 1, 1000)
	category, categoryOK := parseInt(query.Get("category_id"), 1, 100)
	after, afterOK := parseInt(valueOr(query.Get("after"), "0"), 0, maxInt32)
	limit, limitOK := parseInt(valueOr(query.Get("limit"), "20"), 1, 100)
	if !tenantOK || !categoryOK || !afterOK || !limitOK {
		writeError(w, http.StatusBadRequest, "invalid query")
		return
	}

	rows, err := a.pool.Query(r.Context(), a.queries.List, tenant, category, after, limit)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "database unavailable")
		return
	}
	defer rows.Close()

	products := make([]product, 0, limit)
	for rows.Next() {
		var p product
		if err := scanProduct(rows, &p); err != nil {
			writeError(w, http.StatusServiceUnavailable, "database unavailable")
			return
		}
		products = append(products, p)
	}
	if rows.Err() != nil {
		writeError(w, http.StatusServiceUnavailable, "database unavailable")
		return
	}
	writeJSON(w, http.StatusOK, products)
}

func (a *api) reserve(w http.ResponseWriter, r *http.Request) {
	id, ok := parseInt(r.PathValue("id"), 1, maxInt32)
	if !ok {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}

	var res reservation
	err := a.pool.QueryRow(r.Context(), a.queries.Reserve, id).Scan(&res.ProductID, &res.Available)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		writeError(w, http.StatusConflict, "unavailable")
	case err != nil:
		writeError(w, http.StatusServiceUnavailable, "database unavailable")
	default:
		writeJSON(w, http.StatusOK, res)
	}
}

func notFound(w http.ResponseWriter, _ *http.Request) {
	writeError(w, http.StatusNotFound, "not found")
}

func scanProduct(row pgx.Row, p *product) error {
	return row.Scan(&p.ID, &p.TenantID, &p.CategoryID, &p.Name, &p.PriceCents, &p.Stock)
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	body, err := json.Marshal(value)
	if err != nil {
		http.Error(w, "serialization failed", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

// parseInt accepts only plain decimal digits, so "+1", "-1" and "1.5" are rejected.
func parseInt(raw string, min, max int) (int, bool) {
	if raw == "" {
		return 0, false
	}
	for i := 0; i < len(raw); i++ {
		if raw[i] < '0' || raw[i] > '9' {
			return 0, false
		}
	}
	n, err := strconv.Atoi(raw)
	return n, err == nil && n >= min && n <= max
}

func loadQueries() (queries, error) {
	var q queries
	raw, err := os.ReadFile("queries.json")
	if err != nil {
		raw, err = os.ReadFile("../shared/queries.json")
	}
	if err != nil {
		return q, err
	}
	return q, json.Unmarshal(raw, &q)
}

func envOr(key, fallback string) string {
	return valueOr(os.Getenv(key), fallback)
}

func valueOr(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}
