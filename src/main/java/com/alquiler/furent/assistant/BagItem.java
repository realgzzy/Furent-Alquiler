package com.alquiler.furent.assistant;

import java.math.BigDecimal;

/**
 * Artículo de la bolsa del usuario tal como lo envía el widget.
 *
 * El widget guarda la bolsa en {@code localStorage} ({@code furent_bag}); este resumen viaja
 * en la petición del chat para que el asistente pueda verla sin acceder al navegador.
 *
 * @param id        id del producto
 * @param nombre    nombre visible
 * @param cantidad  unidades
 * @param precioDia precio por día reportado por el cliente (informativo)
 */
public record BagItem(String id, String nombre, int cantidad, BigDecimal precioDia) {
}
