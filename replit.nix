{ pkgs }: {
  deps = [
    pkgs.nodejs_22
    pkgs.python312
    pkgs.git
    pkgs.zip
    pkgs.unzip
    pkgs.gnutar
    pkgs.xz
    pkgs.curl
    pkgs.librsvg
  ];
}
