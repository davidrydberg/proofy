# A WooCommerce demo shop. Everything is downloaded here, at build time: the sandbox has no internet once it runs.
FROM wordpress:7.0-php8.3-apache

ARG WOOCOMMERCE_VERSION=11.2.1
ARG WP_CLI_VERSION=2.12.0

RUN apt-get update && apt-get install -y --no-install-recommends unzip mariadb-client && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL -o /usr/local/bin/wp "https://github.com/wp-cli/wp-cli/releases/download/v${WP_CLI_VERSION}/wp-cli-${WP_CLI_VERSION}.phar" \
 && chmod +x /usr/local/bin/wp \
 && curl -fsSL -o /tmp/woocommerce.zip "https://downloads.wordpress.org/plugin/woocommerce.${WOOCOMMERCE_VERSION}.zip" \
 && unzip -q /tmp/woocommerce.zip -d /usr/src/wordpress/wp-content/plugins \
 && rm /tmp/woocommerce.zip

COPY mail-to-mailpit.php /usr/src/wordpress/wp-content/mu-plugins/mail-to-mailpit.php
COPY seed.sh /usr/local/bin/shop-seed
RUN chmod +x /usr/local/bin/shop-seed
