# norootforbuild
Name:           busradar-bw
Version:        1.0.0
Release:        1
Summary:        Live-Bustracker für Baden-Württemberg
License:        MIT AND BSD-2-Clause
Group:          Productivity/Networking/Web/Servers
URL:            https://busradar.pihaar.de
Source0:        busradar-bw-%{version}.tar.gz
Source99:       busradar-bw-rpmlintrc
BuildArch:      noarch
BuildRequires:  systemd-rpm-macros
Requires:       (python314 or python313 or python311 or python3 >= 3.9)
# Pydantic v2 (with field_validator) is required; FastAPI bundles v2 since 0.100.
# Older distro packages ship Pydantic v1, which fails at import time.
Requires:       ((python314-fastapi >= 0.100) or (python313-fastapi >= 0.100) or (python311-fastapi >= 0.100) or (python3-fastapi >= 0.100))
Requires:       ((python314-uvicorn >= 0.20) or (python313-uvicorn >= 0.20) or (python311-uvicorn >= 0.20) or (python3-uvicorn >= 0.20))
Requires:       ((python314-httpx >= 0.24) or (python313-httpx >= 0.24) or (python311-httpx >= 0.24) or (python3-httpx >= 0.24))
%systemd_requires

%description
Live-Bustracker für Baden-Württemberg. Zeigt Echtzeit-Buspositionen
auf einer OpenStreetMap-Karte. HAFAS-API Backend-Proxy mit FastAPI.

%prep
%autosetup -p1

%install
install -d %{buildroot}/opt/busradar
install -m 644 proxy.py tick.py fanout.py stops_builder.py audit.py caches.py hafas.py sse_handler.py %{buildroot}/opt/busradar/
cp -a static %{buildroot}/opt/busradar/
printf '%%s\n' '%{version}-%{release}' > %{buildroot}/opt/busradar/VERSION
install -D -m 644 deploy/busradar.service %{buildroot}%{_unitdir}/busradar.service
install -D -m 644 deploy/busradar-sysusers.conf %{buildroot}%{_sysusersdir}/busradar.conf
install -D -m 644 deploy/busradar-tmpfiles.conf %{buildroot}%{_tmpfilesdir}/busradar.conf

%pre
%service_add_pre busradar.service
%sysusers_create_package busradar deploy/busradar-sysusers.conf

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
/opt/busradar/static
/opt/busradar/VERSION
%{_unitdir}/busradar.service
%{_sysusersdir}/busradar.conf
%{_tmpfilesdir}/busradar.conf

%changelog
