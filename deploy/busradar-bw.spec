# norootforbuild
Name:           busradar-bw
Version:        1.0.0
Release:        1
Summary:        Live-Bustracker für Baden-Württemberg
License:        MIT AND BSD-2-Clause
Group:          Productivity/Networking/Web/Servers
URL:            https://busradar.pihaar.de
Source0:        busradar-bw-%{version}.tar.gz
Source1:        busradar-sysusers.conf
Source99:       busradar-bw-rpmlintrc
BuildArch:      noarch
BuildRequires:  systemd-rpm-macros
BuildRequires:  esbuild
Requires:       (python314 or python313 or python311 or python3 >= 3.9)
# Pydantic v2 (with field_validator) is required; FastAPI bundles v2 since 0.100.
# Older distro packages ship Pydantic v1, which fails at import time.
Requires:       ((python314-fastapi >= 0.100) or (python313-fastapi >= 0.100) or (python311-fastapi >= 0.100) or (python3-fastapi >= 0.100))
# Starlette is a transitive FastAPI dep, but pin its CVE-fixed floor explicitly:
# 1.3.1 fixes CVE-2026-48710/-54282/-54283/-48817/-48818. Prevents a distro
# resolution from pulling a vulnerable Starlette 0.x/1.0.x under a loose FastAPI.
Requires:       ((python314-starlette >= 1.3.1) or (python313-starlette >= 1.3.1) or (python311-starlette >= 1.3.1) or (python3-starlette >= 1.3.1))
Requires:       ((python314-uvicorn >= 0.20) or (python313-uvicorn >= 0.20) or (python311-uvicorn >= 0.20) or (python3-uvicorn >= 0.20))
Requires:       ((python314-httpx >= 0.24) or (python313-httpx >= 0.24) or (python311-httpx >= 0.24) or (python3-httpx >= 0.24))
# rpm's automatic sysusers dependency generator is unreliable for this package
# (it emits neither the user(busradar)/group(busradar) Provides, and the
# Requires(pre) it generates for the pre scriptlet come and go between builds).
# Declare the Provides explicitly so installability is invariant regardless of
# the generator; the user and group are created at install time by the pre
# scriptlet (sysusers_create_package below runs systemd-sysusers).
Provides:       group(busradar)
Provides:       user(busradar)
%systemd_requires

%description
Live-Bustracker für Baden-Württemberg. Zeigt Echtzeit-Buspositionen
auf einer OpenStreetMap-Karte. HAFAS-API Backend-Proxy mit FastAPI.

%prep
%autosetup -p1

%build
# Optimize the frontend at RPM-build time. OBS workers have no network, so the
# only tool used is esbuild (a self-contained binary from the distro) — no
# npm install. init.js is the ESM entry; bundling it inlines config/state/api/
# status/map/ui/refresh/debug/debug-console into one file, collapsing the
# module-load waterfall. i18n.js (classic global), sw.js and style.css are kept
# as separate files but minified. The individual bundled sources are dropped
# from the shipped tree (sw.js PRECACHE already lists only /init.js + /i18n.js).
mkdir -p build
cp -a static build/static
esbuild static/init.js --bundle --minify --format=esm --outfile=build/static/init.js
rm -f build/static/config.js build/static/state.js build/static/api.js \
      build/static/status.js build/static/map.js build/static/ui.js \
      build/static/refresh.js build/static/debug.js build/static/debug-console.js
esbuild static/i18n.js --minify --outfile=build/static/i18n.js
esbuild static/sw.js --minify --outfile=build/static/sw.js
esbuild static/style.css --minify --outfile=build/static/style.css

%install
install -d %{buildroot}/opt/busradar
install -m 644 proxy.py tick.py fanout.py stops_builder.py audit.py caches.py hafas.py sse_handler.py steig.py %{buildroot}/opt/busradar/
cp -a build/static %{buildroot}/opt/busradar/
printf '%%s\n' '%{version}-%{release}' > %{buildroot}/opt/busradar/VERSION
install -D -m 644 deploy/busradar.service %{buildroot}%{_unitdir}/busradar.service
install -D -m 644 %{SOURCE1} %{buildroot}%{_sysusersdir}/busradar.conf
install -D -m 644 deploy/busradar-tmpfiles.conf %{buildroot}%{_tmpfilesdir}/busradar.conf

%pre
%service_add_pre busradar.service
%sysusers_create_package busradar %{SOURCE1}

%post
%service_add_post busradar.service
%tmpfiles_create busradar.conf

%preun
%service_del_preun busradar.service

%postun
%service_del_postun busradar.service

%files
%license LICENSE
%doc README.md
%dir /opt/busradar
/opt/busradar/proxy.py
/opt/busradar/tick.py
/opt/busradar/fanout.py
/opt/busradar/stops_builder.py
/opt/busradar/audit.py
/opt/busradar/caches.py
/opt/busradar/hafas.py
/opt/busradar/sse_handler.py
/opt/busradar/steig.py
/opt/busradar/static
/opt/busradar/VERSION
%{_unitdir}/busradar.service
%{_sysusersdir}/busradar.conf
%{_tmpfilesdir}/busradar.conf
%ghost %dir /var/lib/busradar

%changelog
