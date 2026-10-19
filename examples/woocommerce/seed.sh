#!/bin/sh
# Prepares the empty database: WordPress, WooCommerce, one product, cash on delivery, classic cart and checkout.
set -eu
wp() { command wp --allow-root --path=/var/www/html "$@"; }

wp core install --url="http://wordpress" --title="Demo coffee shop" --admin_user=admin --admin_password=sandbox --admin_email=owner@shop.test --skip-email
wp plugin activate woocommerce
wp option update woocommerce_store_address "Storgatan 1"
wp option update woocommerce_store_city "Malmo"
wp option update woocommerce_store_postcode "21122"
wp option update woocommerce_default_country "SE"
wp option update woocommerce_currency "SEK"
wp option update woocommerce_ship_to_countries "disabled"
wp option update woocommerce_calc_taxes "no"
wp option update woocommerce_coming_soon "no"
wp option update woocommerce_onboarding_profile '{"skipped":true}' --format=json
wp option update woocommerce_cod_settings '{"enabled":"yes","title":"Cash on delivery","description":"Pay when it arrives.","instructions":"","enable_for_methods":[],"enable_for_virtual":"yes"}' --format=json
wp wc tool run install_pages --user=admin >/dev/null
wp post update "$(wp option get woocommerce_cart_page_id)" --post_content='[woocommerce_cart]'
wp post update "$(wp option get woocommerce_checkout_page_id)" --post_content='[woocommerce_checkout]'
# WooCommerce's REST layer has been seen to report a duplicate SKU for a product it just created, so check the result.
wp wc product create --name="Coffee, 500 g" --slug=coffee --sku=COFFEE --regular_price=120 --manage_stock=true --stock_quantity=10 --user=admin --porcelain || true
test "$(wp wc product list --sku=COFFEE --field=id --user=admin | wc -l)" -eq 1
wp rewrite structure '/%postname%/' --hard
