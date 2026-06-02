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
Requires:       (python314-fastapi or python313-fastapi or python311-fastapi or python3-fastapi)
Requires:       (python314-uvicorn or python313-uvicorn or python311-uvicorn or python3-uvicorn)
Requires:       (python314-httpx or python313-httpx or python311-httpx or python3-httpx)
%systemd_requires

%description
Live-Bustracker für Baden-Württemberg. Zeigt Echtzeit-Buspositionen
auf einer OpenStreetMap-Karte. HAFAS-API Backend-Proxy mit FastAPI.

%prep
%autosetup -p1

%install
install -d %{buildroot}/opt/busradar
install -m 644 proxy.py tick.py stops_builder.py %{buildroot}/opt/busradar/
cp -a static %{buildroot}/opt/busradar/
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
/opt/busradar/stops_builder.py
/opt/busradar/static
%{_unitdir}/busradar.service
%{_sysusersdir}/busradar.conf
%{_tmpfilesdir}/busradar.conf

%changelog
