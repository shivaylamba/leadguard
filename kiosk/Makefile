# LeadGuard check-in kiosk under eBPF. Everything runs in Docker Desktop's Linux VM (kernel with BTF => eBPF works).
COMPOSE = docker compose -f docker-compose.yaml

.PHONY: up down reset incident calm learn detect report check ps logs obi-logs prof-logs ports who

up:                ## backends + kiosk + badge taps + OBI + profiler
	$(COMPOSE) up -d

down:
	$(COMPOSE) --profile incident down -v --remove-orphans

reset: down up

incident:          ## the simulated compromise: unplanned listener on 4444 inside the kiosk container + unknown peer polling it
	docker exec -d kiosk sh -c 'cp /app/rogue.py /tmp/.cache.py && exec python /tmp/.cache.py'
	$(COMPOSE) --profile incident up -d --no-deps unknown-client

learn:             ## snapshot what is normal for the kiosk (run while calm)
	@python3 detect.py learn

detect:            ## diff now against the baseline; follow the PID for anything new
	@python3 detect.py detect

report:            ## detect, and send findings to LeadGuard's organizer view (LEADGUARD_URL)
	@python3 detect.py detect --report

check:             ## preflight before going on stage
	@python3 detect.py check

calm:              ## undo the incident
	-$(COMPOSE) --profile incident stop unknown-client
	-docker exec kiosk python /app/stop_rogue.py

ps:
	$(COMPOSE) --profile incident ps

logs:
	$(COMPOSE) logs -f --tail=50 otelcol

obi-logs:
	$(COMPOSE) logs -f --tail=100 obi

prof-logs:
	$(COMPOSE) logs -f --tail=100 profiler

ports:             ## bytes/s per server port, last 2 minutes (what the flows say)
	@curl -s 'http://localhost:19091/api/v1/query' --data-urlencode 'query=sum by (server_port, src_cidr, dst_cidr, src_address) (rate(obi_network_flow_bytes_total{direction="request"}[2m]))' | python3 -c 'import json,sys; [print(r["metric"], round(float(r["value"][1]),1), "B/s") for r in json.load(sys.stdin)["data"]["result"]]'

who:               ## which process answers on each port (what OBI says): service, host:pid, route
	@curl -s 'http://localhost:19091/api/v1/query' --data-urlencode 'query=sum by (server_port, service_name, service_instance_id, http_route) (rate(http_server_request_duration_seconds_count[2m])) > 0' | python3 -c 'import json,sys; [print(r["metric"], round(float(r["value"][1]),2), "req/s") for r in json.load(sys.stdin)["data"]["result"]]'
