"""
Serve the barcode scanner over HTTPS on the local network so phones can use
the camera. Browsers only allow camera access on https:// or localhost, so we
generate a self-signed certificate on first run and serve the folder with TLS.

Run:  python serve.py
Then on your phone (same Wi-Fi) open the https URL it prints.
"""
import datetime
import http.server
import ipaddress
import socket
import ssl
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

HERE = Path(__file__).parent
CERT = HERE / "cert.pem"
KEY = HERE / "key.pem"
PORT = 8443


def local_ip() -> str:
    """Best-effort LAN IP of this machine."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


def make_cert(ip: str) -> None:
    """Generate a self-signed cert valid for localhost and this LAN IP."""
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, ip)])
    alt_names = [
        x509.DNSName("localhost"),
        x509.IPAddress(ipaddress.ip_address("127.0.0.1")),
    ]
    try:
        alt_names.append(x509.IPAddress(ipaddress.ip_address(ip)))
    except ValueError:
        pass
    now = datetime.datetime.utcnow()
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=825))
        .add_extension(x509.SubjectAlternativeName(alt_names), critical=False)
        .sign(key, hashes.SHA256())
    )
    CERT.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    KEY.write_bytes(
        key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        )
    )


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(HERE), **kwargs)

    def end_headers(self):
        # No caching so edits show up immediately on the phone.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def main():
    ip = local_ip()
    if not CERT.exists() or not KEY.exists():
        print("Generating self-signed certificate...")
        make_cert(ip)

    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(certfile=str(CERT), keyfile=str(KEY))

    httpd = http.server.ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)

    print("\nBarcode scanner is running over HTTPS.\n")
    print(f"  On this PC:     https://localhost:{PORT}/")
    print(f"  On your phone:  https://{ip}:{PORT}/")
    print("\nThe certificate is self-signed, so the browser will warn you once.")
    print('Tap "Advanced" -> "Proceed" (or "Continue") to accept it.')
    print("\nPress Ctrl+C to stop.\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
